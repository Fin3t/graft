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

export interface PackageIndex {
  key: string;
  byGuid: Record<string, PackageAsset>;
}

const CACHE_FILE = "unity-packages.json";
const CACHE_VERSION = 1;

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
  for (const d of dirs) {
    const pkg = d.replace(/@[^@]*$/, "");
    scanDir(join(pc, d), "", pkg, byGuid, 0);
  }
  const index: PackageIndex = { key, byGuid };
  if (cachePath) {
    try {
      writeJsonAtomic(cachePath, index, true);
    } catch {
      /* cache is best-effort */
    }
  }
  return index;
}

function scanDir(abs: string, rel: string, pkg: string, out: Record<string, PackageAsset>, depth: number): void {
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
        const head = readHead(join(abs, asset), 16384);
        const ns = /^\s*namespace\s+([\w.]+)/m.exec(head)?.[1];
        const name = asset.slice(0, -3);
        a.cls = ns ? `${ns}.${name}` : name;
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
    if (st.isDirectory()) scanDir(full, rel ? `${rel}/${e}` : e, pkg, out, depth + 1);
  }
}

function readHead(path: string, bytes: number): string {
  try {
    const buf = readFileSync(path);
    return buf.subarray(0, bytes).toString("utf8");
  } catch {
    return "";
  }
}
