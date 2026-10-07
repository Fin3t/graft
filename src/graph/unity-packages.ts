/**
 * External symbols from a Unity project's resolved packages (`Library/PackageCache`).
 *
 * Package sources are not the project's code and are deliberately NOT indexed as
 * graph content — but the project's assets point into them by GUID all the time:
 * a uGUI `Button` component, a URP `Particles/Unlit` material shader, an Input
 * System `PlayerInput`. This index answers "what does this GUID name?" with the
 * package path, the C# class (for scripts: Unity requires the class to be named
 * after its file) and the shader name, so those references resolve to a truthful
 * external name instead of being dropped.
 *
 * Scanning reads only `.meta` files plus the first lines of scripts/shaders, and
 * is cached in the graph's cache dir keyed by the PackageCache directory listing
 * (each entry is `name@contenthash`, so any package change renames its folder).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { readJson, writeJsonAtomic } from "../util/state.js";

export interface PackageAsset {
  /** Package-relative virtual path: `Packages/<name>/<path inside the package>`. */
  path: string;
  pkg: string;
  /** Script: fully-qualified class name. */
  cls?: string;
  /** Shader / shader graph: the name materials and `Shader.Find` use. */
  shader?: string;
  /** asmdef: assembly name. */
  asm?: string;
}

/** A type declared in a package's C# sources: enough to name it and walk its bases. */
export interface PackageType {
  k: "class" | "interface" | "struct" | "enum";
  /** Generic arity. */
  g?: number;
  /** Base list as written, and the namespaces in scope to resolve it in. */
  bases?: string[];
  scope?: string[];
}

export interface PackageIndex {
  key: string;
  byGuid: Record<string, PackageAsset>;
  /** "Ns.Name" (+ "`n" when generic) → declaration. */
  types?: Record<string, PackageType>;
}

const CACHE_FILE = "unity-packages.json";
const CACHE_VERSION = 2;

/** Load (or build and cache) the package index for a Unity project root. Empty
 * when the project has no PackageCache (not a Unity project, or never opened). */
export function loadPackageIndex(root: string, cacheDir: string | null): PackageIndex {
  const pc = join(root, "Library", "PackageCache");
  if (!existsSync(pc)) return { key: "", byGuid: {} };
  let dirs: string[];
  try {
    dirs = readdirSync(pc).filter((d) => !d.startsWith(".")).sort();
  } catch {
    return { key: "", byGuid: {} };
  }
  const key = createHash("sha256").update(`${CACHE_VERSION}\n${dirs.join("\n")}`).digest("hex").slice(0, 16);
  const cachePath = cacheDir ? join(cacheDir, CACHE_FILE) : null;
  if (cachePath) {
    const cached = readJson<PackageIndex>(cachePath);
    if (cached?.key === key && cached.byGuid) return cached;
  }
  const byGuid: Record<string, PackageAsset> = {};
  const types: Record<string, PackageType> = {};
  for (const d of dirs) {
    const pkg = d.replace(/@[^@]*$/, "");
    scanDir(join(pc, d), "", pkg, byGuid, 0, types);
  }
  const index: PackageIndex = { key, byGuid, types };
  if (cachePath) {
    try {
      writeJsonAtomic(cachePath, index, true);
    } catch {
      /* cache is best-effort */
    }
  }
  return index;
}

function scanDir(abs: string, rel: string, pkg: string, out: Record<string, PackageAsset>, depth: number, types: Record<string, PackageType>): void {
  if (depth > 24) return;
  let entries: string[];
  try {
    entries = readdirSync(abs);
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.startsWith(".") || e.endsWith("~")) continue; // Unity ignores dot- and tilde-folders
    const full = join(abs, e);
    if (e.endsWith(".meta")) {
      const asset = e.slice(0, -5);
      let text: string;
      try {
        text = readFileSync(full, "utf8");
      } catch {
        continue;
      }
      const guid = /^guid:\s*([0-9a-fA-F]{32})/m.exec(text)?.[1]?.toLowerCase();
      if (!guid) continue;
      const path = `Packages/${pkg}/${rel ? `${rel}/` : ""}${asset}`;
      const a: PackageAsset = { path, pkg };
      const lower = asset.toLowerCase();
      if (lower.endsWith(".cs")) {
        const text = readHead(join(abs, asset), 1 << 20);
        const ns = /^\s*namespace\s+([\w.]+)/m.exec(text)?.[1];
        const name = asset.slice(0, -3);
        a.cls = ns ? `${ns}.${name}` : name;
        declarations(text, ns ?? "", types);
      } else if (lower.endsWith(".shader")) {
        const head = readHead(join(abs, asset), 4096);
        const name = /^\s*Shader\s+"([^"]+)"/m.exec(head)?.[1];
        if (name) a.shader = name;
      } else if (lower.endsWith(".shadergraph")) {
        const head = readHead(join(abs, asset), 1 << 20);
        const p = /"m_Path"\s*:\s*"([^"]*)"/.exec(head)?.[1] ?? "Shader Graphs";
        a.shader = `${p}/${asset.replace(/\.shadergraph$/i, "")}`;
      } else if (lower.endsWith(".asmdef")) {
        const head = readHead(join(abs, asset), 8192);
        const name = /"name"\s*:\s*"([^"]+)"/.exec(head)?.[1];
        if (name) a.asm = name;
      }
      out[guid] = a;
      continue;
    }
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) scanDir(full, rel ? `${rel}/${e}` : e, pkg, out, depth + 1, types);
  }
}

const DECL = /\b(class|interface|struct|enum)\s+([A-Za-z_]\w*)\s*(<[^>{;()]*>)?\s*(?::\s*([^{;]*?))?\s*(?:\bwhere\b[^{;]*)?\{/g;

/** Type declarations in a package source file (comments stripped first). Nested
 * types land in the file's namespace — close enough for naming bases. */
function declarations(text: string, ns: string, out: Record<string, PackageType>): void {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "").replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
  const usings = [...code.matchAll(/^\s*using\s+([\w.]+)\s*;/gm)].map((m) => m[1]);
  const scope = [...new Set([ns, ...usings].filter(Boolean))];
  for (const m of code.matchAll(DECL)) {
    const [, kw, name, gen, baseList] = m;
    const g = gen ? gen.split(",").length : 0;
    const key = `${ns ? `${ns}.` : ""}${name}${g ? `\`${g}` : ""}`;
    if (out[key]) continue;
    const t: PackageType = { k: kw as PackageType["k"] };
    if (g) t.g = g;
    const bases = splitBases(baseList ?? "");
    if (bases.length) {
      t.bases = bases;
      t.scope = scope;
    }
    out[key] = t;
  }
}

function splitBases(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const c of list) {
    if (c === "<") depth++;
    else if (c === ">") depth--;
    if (c === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.map((b) => b.replace(/\s+/g, "")).filter((b) => /^[\w.<>,]+$/.test(b));
}

/** Package types as API entries for the C# resolver: kind, base class and
 * interfaces with names resolved against package types and the API data. */
export function packageApiTypes(index: PackageIndex, known: Record<string, { k: string }>): Record<string, { k: "class" | "interface" | "struct" | "enum"; b?: string; i?: string[] }> {
  const types = index.types ?? {};
  const bySimple = new Map<string, string[]>();
  for (const k of Object.keys(types)) {
    const simple = k.replace(/`\d+$/, "").split(".").pop()!;
    bySimple.set(simple, [...(bySimple.get(simple) ?? []), k]);
  }
  const resolveName = (raw: string, scope: string[]): { key: string; k: string } | null => {
    const bare = raw.replace(/<.*$/, "");
    const arity = raw.includes("<") ? splitBases(raw.slice(raw.indexOf("<") + 1, raw.lastIndexOf(">"))).length : 0;
    const suffix = arity ? `\`${arity}` : "";
    const candidates = bare.includes(".") ? [bare, ...scope.map((s) => `${s}.${bare}`)] : scope.map((s) => `${s}.${bare}`);
    for (const c of candidates) {
      const key = `${c}${suffix}`;
      if (types[key]) return { key, k: types[key].k };
      if (known[key]) return { key, k: known[key].k };
    }
    const same = (bySimple.get(bare.split(".").pop()!) ?? []).filter((k) => k.endsWith(suffix || "") && !/`\d+$/.test(k) === !suffix);
    if (same.length === 1) return { key: same[0], k: types[same[0]].k };
    return null;
  };
  const out: Record<string, { k: "class" | "interface" | "struct" | "enum"; b?: string; i?: string[] }> = {};
  for (const [key, t] of Object.entries(types)) {
    const entry: { k: "class" | "interface" | "struct" | "enum"; b?: string; i?: string[] } = { k: t.k };
    for (const raw of t.bases ?? []) {
      const r = resolveName(raw, t.scope ?? []);
      if (!r) continue;
      const text = r.key.replace(/`\d+$/, "");
      if (r.k === "interface" || (t.k === "interface")) (entry.i ??= []).push(text);
      else if (!entry.b && t.k === "class") entry.b = text;
    }
    out[key] = entry;
  }
  return out;
}

function readHead(path: string, bytes: number): string {
  try {
    const buf = readFileSync(path);
    return buf.subarray(0, bytes).toString("utf8");
  } catch {
    return "";
  }
}
