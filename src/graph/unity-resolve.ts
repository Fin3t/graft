/**
 * Unity resolution: asset facts + intents (unity.ts) and string references found
 * in C# (csharp.ts) → edges, plus the nodes only the whole project can name.
 *
 *   - GUIDs: every `.meta` maps a GUID to its asset. A script GUID names the class
 *     declared in that file (Unity requires class name == file name); a prefab,
 *     material or clip GUID names that file's node; a texture/mesh/audio GUID —
 *     a binary asset graft does not parse — gets an `asset` node minted here, so
 *     "who uses this texture" has something to point at. GUIDs from resolved
 *     packages (Library/PackageCache) mint foreign nodes (`pkg` set).
 *   - Strings in code: `Resources.Load("Manual/x")` → the asset under a Resources
 *     folder, `Shader.Find`, `SceneManager.LoadScene`, `AssetDatabase.LoadAssetAtPath`,
 *     Animator parameters and states, shader properties, tags, layers,
 *     `SendMessage`/`Invoke`/`StartCoroutine` method names, Input System actions.
 *     Constant arguments (`AttackId = Animator.StringToHash("Attack")`) resolve
 *     through the C# model.
 *   - Engine entry points: a method Unity (or the test runner) calls is stamped
 *     with `entry`, so it never reads as dead code.
 */
import { basename, dirname, extname } from "node:path";
import { contentHash } from "../util/id.js";
import type { EdgeV1, NodeV1, Relation } from "./types.js";
import type { FileFacts, RawEdge } from "./extract.js";
import type { CsMemberFact, CsUnityIntent, StrVal } from "./csharp.js";
import type { CsModel, TypeInfo } from "./csharp-resolve.js";
import { includeCandidates, type UnityFacts, type UnityIntent } from "./unity.js";
import type { PackageIndex } from "./unity-packages.js";

export interface UnityResolveOptions {
  packages?: PackageIndex;
  /** `-executeMethod` targets mentioned anywhere in the repo. */
  executeMethods?: Array<{ method: string; file: string; line: number }>;
}

/** Text extensions graft parses; any other asset is known only through its `.meta`. */
const RESOURCE_TYPE_EXTS: Record<string, string[]> = {
  Texture2D: [".png", ".jpg", ".jpeg", ".tga", ".psd", ".exr", ".hdr", ".tif", ".tiff", ".gif", ".bmp"],
  Texture: [".png", ".jpg", ".jpeg", ".tga", ".psd", ".exr", ".hdr", ".tif", ".tiff", ".gif", ".bmp", ".rendertexture", ".asset"],
  Sprite: [".png", ".jpg", ".jpeg", ".tga", ".psd"],
  AudioClip: [".wav", ".mp3", ".ogg", ".aif", ".aiff", ".flac"],
  GameObject: [".prefab", ".fbx", ".glb", ".gltf", ".obj", ".blend"],
  Material: [".mat"],
  Shader: [".shader", ".shadergraph"],
  TextAsset: [".txt", ".json", ".bytes", ".csv", ".xml", ".html", ".md", ".yaml", ".yml"],
  Font: [".ttf", ".otf"],
  AnimationClip: [".anim", ".fbx"],
  RuntimeAnimatorController: [".controller", ".overridecontroller"],
  Mesh: [".fbx", ".obj", ".asset", ".glb"],
  VideoClip: [".mp4", ".mov", ".webm"],
  ParticleSystem: [".prefab"],
};

const ENTRY_ATTRS: Record<string, string> = {
  RuntimeInitializeOnLoadMethod: "Unity calls it at startup [RuntimeInitializeOnLoadMethod]",
  InitializeOnLoadMethod: "Unity Editor calls it after every domain reload [InitializeOnLoadMethod]",
  InitializeOnEnterPlayMode: "Unity Editor calls it when entering Play Mode [InitializeOnEnterPlayMode]",
  DidReloadScripts: "Unity Editor calls it after scripts reload [DidReloadScripts]",
  PostProcessBuild: "Unity calls it after a build [PostProcessBuild]",
  PostProcessScene: "Unity calls it for each scene in a build [PostProcessScene]",
  OnOpenAsset: "Unity Editor calls it to open an asset [OnOpenAsset]",
  Test: "NUnit test [Test]",
  TestCase: "NUnit test [TestCase]",
  TestCaseSource: "NUnit test [TestCaseSource]",
  UnityTest: "Unity Test Framework test [UnityTest]",
  SetUp: "test runner calls it before each test [SetUp]",
  TearDown: "test runner calls it after each test [TearDown]",
  OneTimeSetUp: "test runner calls it once before the fixture [OneTimeSetUp]",
  OneTimeTearDown: "test runner calls it once after the fixture [OneTimeTearDown]",
  UnitySetUp: "test runner calls it before each test [UnitySetUp]",
  UnityTearDown: "test runner calls it after each test [UnityTearDown]",
  UnityOneTimeSetUp: "test runner calls it once before the fixture [UnityOneTimeSetUp]",
  UnityOneTimeTearDown: "test runner calls it once after the fixture [UnityOneTimeTearDown]",
  SettingsProvider: "Unity Editor calls it to build a settings page [SettingsProvider]",
  Shortcut: "Unity Editor shortcut [Shortcut]",
  ClutchShortcut: "Unity Editor shortcut [ClutchShortcut]",
};

/** Interfaces whose members the engine/editor calls. */
const CALLBACK_IFACE = /^(UnityEngine\.EventSystems\.I\w+Handler|UnityEngine\.ISerializationCallbackReceiver|UnityEditor\.Build\.I\w+|UnityEngine\.Rendering\.\w+|UnityEngine\.InputSystem\.\w+)$/;

interface StrOut {
  s: string;
  open: boolean; // followed by a part only known at run time
}

export function resolveUnity(
  nodes: NodeV1[],
  rawEdges: RawEdge[],
  factsByFile: Map<string, FileFacts>,
  cs: CsModel | null,
  opts: UnityResolveOptions = {},
  prior: EdgeV1[] = [],
): EdgeV1[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out: EdgeV1[] = [];
  const seen = new Map<string, EdgeV1>();
  // `addEdge` is the plain adder; resolveCodeString shadows `add` to credit constants.
  const namesOf = new Map<string, Set<string>>(); // constant → what its string names
  const add = (source: string, target: string, relation: Relation, confidence: EdgeV1["confidence"] = "extracted", via?: string) => {
    if (!source || !target || source === target) return;
    if (!byId.has(source)) return;
    const key = `${source}\0${relation}\0${target}`;
    const prev = seen.get(key);
    if (prev) {
      if (via && prev.via !== undefined && !prev.via.split(", ").includes(via) && prev.via.length < 240) prev.via += `, ${via}`;
      return;
    }
    const e: EdgeV1 = { source, target, relation, confidence };
    if (via) e.via = via;
    seen.set(key, e);
    out.push(e);
  };
  const addEdge = add;

  // ── indexes ──
  const guidToPath = new Map<string, string>();
  const metaOf = new Map<string, NonNullable<UnityFacts["meta"]>>();
  const assetFacts = new Map<string, NonNullable<UnityFacts["asset"]>>();
  for (const [file, f] of factsByFile) {
    const u = f.unity;
    if (u?.meta) {
      guidToPath.set(u.meta.guid, u.meta.asset);
      metaOf.set(u.meta.asset, u.meta);
    }
    if (u?.asset) assetFacts.set(file, u.asset);
  }
  const fileNodes = new Set(nodes.filter((n) => n.kind === "file").map((n) => n.id));
  const pkgs = opts.packages?.byGuid ?? {};

  /** Mint a node for an asset graft does not parse (texture, mesh, folder, package asset). */
  const synth = (id: string, name: string, signature: string, pkg?: string): string => {
    if (byId.has(id)) return id;
    const n: NodeV1 = {
      id,
      name,
      kind: "asset",
      path: id,
      span: "L1-L1",
      signature,
      exported: true,
      origin: "ast",
      body_hash: contentHash(id),
      body_text: `${name} ${signature} ${id}`,
      summary_state: "pending",
      summary: null,
      crux: null,
      ...(pkg ? { pkg } : {}),
    };
    nodes.push(n);
    byId.set(id, n);
    return id;
  };

  const assetNodeForPath = (path: string): string | null => {
    if (fileNodes.has(path)) return path;
    const meta = metaOf.get(path);
    if (!meta) return byId.has(path) ? path : null;
    if (meta.folder) return synth(path, basename(path), "folder");
    const ext = extname(path).toLowerCase();
    return synth(path, basename(path), `${meta.importer ?? "asset"}${ext ? ` (${ext.slice(1)})` : ""}`);
  };

  /** A GUID (+ fileID) → node id, or an external name; null when unknown. */
  const assetTarget = (guid: string, fid?: string): string | null => {
    const path = guidToPath.get(guid);
    if (path) {
      const af = assetFacts.get(path);
      if (fid && af?.objects?.[fid]) return af.objects[fid];
      if (path.toLowerCase().endsWith(".cs")) return scriptClass(guid, undefined) ?? assetNodeForPath(path);
      return assetNodeForPath(path);
    }
    const p = pkgs[guid];
    if (p) {
      const name = p.shader ?? p.cls ?? basename(p.path);
      return synth(p.path, name, `${p.shader ? `Shader "${p.shader}"` : p.cls ? `class ${p.cls}` : "asset"} from package ${p.pkg}`, p.pkg);
    }
    return null;
  };

  // ── scripts → classes ──
  const scriptCache = new Map<string, string | null>();
  function scriptClass(guid: string | undefined, cls: string | undefined): string | null {
    const key = `${guid ?? ""}|${cls ?? ""}`;
    if (scriptCache.has(key)) return scriptCache.get(key)!;
    let r: string | null = null;
    const path = guid ? guidToPath.get(guid) : undefined;
    if (path && cs) {
      const stem = basename(path, extname(path));
      const facts = factsByFile.get(path)?.cs;
      const t = facts?.types.find((x) => x.name === stem && !x.outer) ?? facts?.types.find((x) => x.name === stem);
      if (t) r = cs.byId.get(t.id)?.id ?? t.id;
    }
    if (!r && cls && cs) {
      const short = cls.split(".").pop()!;
      const cands = cs.typesNamed(short).filter((t) => cs.fqnOf({ k: "in", t, args: [] }) === cls);
      if (cands.length === 1) r = cands[0].id;
    }
    if (!r && guid && pkgs[guid]?.cls) {
      // a package component (uGUI Button, NavMeshSurface, PlayerInput): a foreign
      // node named by its class, so `callers NavMeshSurface` finds the scenes
      const p = pkgs[guid];
      const short = p.cls!.split(".").pop()!;
      r = synth(p.path, short, `class ${p.cls} (package ${p.pkg})`, p.pkg);
      const n = byId.get(r);
      if (n) n.kind = "class";
    }
    if (!r && cls) r = cls;
    scriptCache.set(key, r);
    return r;
  }

  // ── names ──
  const shaderByName = new Map<string, string>();
  for (const [file, af] of assetFacts) if (af.shaderName) shaderByName.set(af.shaderName, file);
  const pkgShaders = new Map<string, string>(); // shader name → package GUID
  for (const [guid, p] of Object.entries(pkgs)) if (p.shader && !pkgShaders.has(p.shader)) pkgShaders.set(p.shader, guid);
  const shaderNode = (name: string): string | null => {
    const f = shaderByName.get(name);
    if (f) return f;
    const guid = pkgShaders.get(name);
    return guid ? (assetTarget(guid) ?? null) : null;
  };
  const byKindName = new Map<string, NodeV1[]>();
  for (const n of nodes) {
    if (n.kind !== "parameter" && n.kind !== "state" && n.kind !== "tag" && n.kind !== "layer" && n.kind !== "action" && n.kind !== "property") continue;
    const k = `${n.kind}\0${n.name}`;
    byKindName.set(k, [...(byKindName.get(k) ?? []), n]);
  }
  const named = (kind: string, name: string): NodeV1[] => byKindName.get(`${kind}\0${name}`) ?? [];
  const shaderProps = (name: string): NodeV1[] => named("property", name).filter((n) => /\.(shader|shadergraph|shadersubgraph)$/i.test(n.path));
  const tagManager = [...assetFacts.entries()].find(([, a]) => a.layers)?.[1];
  const addresses = new Map<string, string[]>(); // Addressables address → asset GUIDs
  for (const a of assetFacts.values()) for (const x of a.addresses ?? []) addresses.set(x.address, [...(addresses.get(x.address) ?? []), x.guid]);
  const buildScenes = [...assetFacts.values()].find((a) => a.scenes)?.scenes ?? [];
  const scenesByName = new Map<string, string[]>();
  for (const id of fileNodes) if (id.toLowerCase().endsWith(".unity")) {
    const k = basename(id, ".unity");
    scenesByName.set(k, [...(scenesByName.get(k) ?? []), id]);
  }

  // Resources index: "Manual/basic-knife" → asset paths under any Resources folder.
  const resources = new Map<string, string[]>();
  const resourceFolders = new Map<string, string[]>();
  const allAssetPaths = new Set<string>([...metaOf.keys(), ...fileNodes]);
  for (const p of allAssetPaths) {
    const i = p.lastIndexOf("/Resources/");
    if (i < 0) continue;
    const restPath = p.slice(i + "/Resources/".length);
    const meta = metaOf.get(p);
    if (meta?.folder) {
      resourceFolders.set(restPath, [...(resourceFolders.get(restPath) ?? []), p]);
      continue;
    }
    if (p.endsWith(".meta")) continue;
    const key = restPath.replace(/\.[^./]+$/, "");
    resources.set(key, [...(resources.get(key) ?? []), p]);
  }

  // ── string values of code arguments ──
  const strings = (e: RawEdge, sv: StrVal, depth = 0): StrOut[] => {
    let acc: StrOut[] = [{ s: "", open: false }];
    for (const part of sv) {
      if (acc.every((a) => a.open)) break;
      if (typeof part === "string") acc = acc.map((a) => (a.open ? a : { s: a.s + part, open: false }));
      else if (part === null) acc = acc.map((a) => ({ s: a.s, open: true }));
      else {
        const ui = e.unity as CsUnityIntent;
        const cv = cs && depth < 4 ? cs.constValues(e.file, ui.u, ui.ty, e.source, part[1]) : null;
        if (!cv || !cv.values.length) acc = acc.map((a) => ({ s: a.s, open: true }));
        else {
          const next: StrOut[] = [];
          for (const a of acc) {
            if (a.open) {
              next.push(a);
              continue;
            }
            for (const v of cv.values.slice(0, 64)) {
              const open = v.includes("\0");
              next.push({ s: a.s + v.replace(/\0.*$/, ""), open });
            }
          }
          acc = next.slice(0, 256);
        }
      }
    }
    return acc;
  };
  const argStrings = (e: RawEdge, i: number): StrOut[] => {
    const ui = e.unity as CsUnityIntent;
    return (ui.args[i] ?? []).flatMap((sv) => strings(e, sv));
  };

  const recvInfo = (e: RawEdge): { fqn: string | null; name: string | null } => {
    const ui = e.unity as CsUnityIntent;
    if (!ui.recv) return { fqn: null, name: null };
    const name = ui.recv[0] === "i" ? ui.recv[1] : ui.recv[0] === "m" ? ui.recv[2] : null;
    let fqn: string | null = null;
    if (cs) {
      try {
        const tv = cs.typeOf(e.file, ui.u, ui.ty, e.source, ui.recv);
        if (tv) fqn = cs.fqnOf(tv);
      } catch {
        fqn = null;
      }
    }
    return { fqn, name };
  };

  const typeExts = (targ: string | undefined): string[] | null => {
    if (!targ) return null;
    const short = targ.split(".").pop()!.replace(/<.*$/, "");
    if (RESOURCE_TYPE_EXTS[short]) return RESOURCE_TYPE_EXTS[short];
    return null; // a ScriptableObject or component type: any asset
  };

  const resourceTargets = (v: StrOut, targ: string | undefined, all: boolean): string[] => {
    const exts = typeExts(targ);
    const fits = (p: string) => !exts || exts.includes(extname(p).toLowerCase()) || (!extname(p) && true);
    const key = v.s.replace(/^\/+/, "").replace(/\/+$/, "");
    if (!v.open && !all) {
      const hits = (resources.get(key) ?? []).filter(fits);
      return (hits.length ? hits : (resources.get(key) ?? [])).map((p) => assetNodeForPath(p)).filter((x): x is string => !!x);
    }
    // LoadAll(folder) or a run-time tail: the folder, else every asset under the prefix
    const folder = all ? key : v.s.endsWith("/") ? key : null;
    const folders = folder !== null ? (resourceFolders.get(folder) ?? []) : [];
    const under = [...resources.keys()].filter((k) => k.startsWith(all && key ? `${key}/` : key)).flatMap((k) => resources.get(k)!).filter(fits);
    // the folder when there is one, and the assets themselves while they are few
    const listed = under.length <= 40 ? under : [];
    if (folders.length || listed.length) return [...folders, ...listed].map((p) => assetNodeForPath(p)).filter((x): x is string => !!x);
    const dir = key.includes("/") ? key.slice(0, key.lastIndexOf("/")) : key;
    return (resourceFolders.get(dir) ?? []).map((p) => assetNodeForPath(p)).filter((x): x is string => !!x);
  };

  const pathTargets = (v: StrOut): string[] => {
    if (!v.open) {
      const t = assetNodeForPath(v.s);
      return t ? [t] : [];
    }
    const dir = v.s.endsWith("/") ? v.s.slice(0, -1) : v.s.includes("/") ? v.s.slice(0, v.s.lastIndexOf("/")) : v.s;
    const t = metaOf.get(dir)?.folder ? assetNodeForPath(dir) : null;
    if (t) return [t];
    const under = [...allAssetPaths].filter((p) => p.startsWith(v.s) && !metaOf.get(p)?.folder);
    return under.length <= 20 ? under.map((p) => assetNodeForPath(p)).filter((x): x is string => !!x) : [];
  };

  const sceneTargets = (v: StrOut): string[] => {
    if (v.open) return [];
    if (/^#\d+$/.test(v.s)) {
      // build index: the n-th enabled scene of EditorBuildSettings
      const s = buildScenes.filter((x) => x.enabled)[Number(v.s.slice(1))];
      return s && fileNodes.has(s.path) ? [s.path] : [];
    }
    if (v.s.endsWith(".unity")) return fileNodes.has(v.s) ? [v.s] : [];
    const inBuild = buildScenes.filter((s) => basename(s.path, ".unity") === v.s).map((s) => s.path).filter((p) => fileNodes.has(p));
    if (inBuild.length) return inBuild;
    if (v.s.includes("/")) {
      const p = `${v.s}.unity`;
      return fileNodes.has(p) ? [p] : buildScenes.filter((s) => s.path.endsWith(`/${p}`)).map((s) => s.path);
    }
    return scenesByName.get(v.s) ?? [];
  };

  const methodsNamed = (name: string, scope: TypeInfo[] | null): string[] => {
    if (!cs) return [];
    const types = scope ?? cs.types.filter((t) => cs.derivesFrom(t, "UnityEngine.MonoBehaviour"));
    const outIds: string[] = [];
    for (const t of types) for (const m of cs.membersOf(t, name)) if (m.fact.id && (m.fact.mk === "method" || m.fact.mk === "local")) outIds.push(m.fact.id);
    return [...new Set(outIds)];
  };

  // ── intents ──
  const pathRefs = new Map<string, Array<{ t: string; via: string }>>(); // code node → assets its path literals name
  const asmrefTargets = new Map<string, string>(); // asmref folder → assembly node
  const entries = new Map<string, Set<string>>();
  const mark = (id: string | null | undefined, why: string) => {
    if (!id || !byId.has(id)) return;
    const set = entries.get(id) ?? new Set<string>();
    set.add(why);
    entries.set(id, set);
  };

  for (const e of rawEdges) {
    const u = e.unity;
    if (!u) continue;
    if ("op" in u) {
      resolveCodeString(e, u);
      continue;
    }
    if (e.targetId) {
      add(e.source, e.targetId, e.relation, "extracted", u.k === "asset" ? u.via : undefined);
      continue;
    }
    // intents from a `.meta` hang off the asset node, minted on demand
    if (!byId.has(e.source)) {
      const minted = assetNodeForPath(e.source);
      if (!minted) continue;
    }
    switch (u.k) {
      case "script": {
        const t = scriptClass(u.guid, u.cls);
        if (t) add(e.source, t, e.relation, byId.has(t) ? "extracted" : "inferred");
        const n = byId.get(e.source);
        if (t && n?.kind === "component" && n.signature?.startsWith("MonoBehaviour on")) {
          n.signature = n.signature.replace(/^MonoBehaviour/, t.includes("#") ? (byId.get(t)?.name ?? "MonoBehaviour") : t.split(".").pop()!);
        }
        break;
      }
      case "asset": {
        const t = assetTarget(u.guid, u.fid);
        if (t) add(e.source, t, u.rel ?? e.relation, byId.has(t) ? "extracted" : "inferred", u.via);
        break;
      }
      case "prefab": {
        const t = assetTarget(u.guid);
        if (t) add(e.source, t, e.relation, "extracted", u.via);
        break;
      }
      case "variant": {
        const t = assetTarget(u.guid);
        if (t) add(e.source, t, "variant_of", "extracted");
        break;
      }
      case "so": {
        const t = scriptClass(u.guid || undefined, u.cls);
        if (t) {
          add(e.source, t, "instance_of", byId.has(t) ? "extracted" : "inferred");
          const n = byId.get(e.source);
          const clsName = byId.get(t)?.name ?? t.split(".").pop();
          if (n && clsName) n.signature = `${clsName} asset "${n.signature?.match(/"([^"]*)"/)?.[1] ?? basename(n.path)}"`;
        }
        break;
      }
      case "shader": {
        if (u.name) {
          const t = shaderNode(u.name);
          if (t) add(e.source, t, e.relation, "extracted", u.via);
        } else if (u.guid) {
          const t = assetTarget(u.guid, u.fid);
          if (t) add(e.source, t, "uses_shader", byId.has(t) ? "extracted" : "inferred");
        }
        break;
      }
      case "call": {
        const targets = unityEventTargets(u.type, u.method, u.script);
        for (const t of targets) {
          add(e.source, t, "invokes", "extracted", u.via);
          mark(t, `UnityEvent ${u.via} (${byId.get(e.source)?.path ?? ""})`);
        }
        break;
      }
      case "animevent": {
        const targets = animationEventTargets(e.source, u.fn);
        for (const t of targets) {
          add(e.source, t, "invokes", "inferred", `AnimationEvent ${u.fn}`);
          mark(t, `AnimationEvent in ${basename(e.source)}`);
        }
        break;
      }
      case "tag": {
        for (const n of named("tag", u.name)) add(e.source, n.id, "references", "extracted", "m_TagString");
        break;
      }
      case "layer": {
        const name = u.name ?? (u.index !== undefined ? tagManager?.layers?.[u.index] : undefined);
        if (name) for (const n of named("layer", name)) add(e.source, n.id, "references", "extracted", u.via ?? "m_Layer");
        break;
      }
      case "include": {
        const from = byId.get(e.source)?.path ?? e.file;
        const cands = includeCandidates(from, u.path);
        const hit = cands.find((c) => fileNodes.has(c));
        add(e.source, hit ?? u.path, "imports", "extracted");
        break;
      }
      case "asmref": {
        // `references` entries are names or "GUID:<guid>"
        const target = asmTarget(u.ref);
        if (u.rel === "imports") add(e.source, target ?? u.ref.replace(/^GUID:/, ""), "imports", target ? "extracted" : "inferred");
        else if (target) asmrefTargets.set(dirname(e.file), target);
        break;
      }
      case "scene": {
        const t = (u.guid ? assetTarget(u.guid) : null) ?? (fileNodes.has(u.path) ? u.path : null);
        if (t) add(e.source, t, "references", "extracted", u.via);
        break;
      }
    }
  }

  function asmTarget(ref: string): string | null {
    if (ref.startsWith("GUID:")) {
      const path = guidToPath.get(ref.slice(5).toLowerCase());
      if (path) {
        const name = assetFacts.get(path)?.asm?.name;
        if (name) return `${path}#${name}`;
      }
      const p = pkgs[ref.slice(5).toLowerCase()];
      return p?.asm ?? null;
    }
    for (const [path, a] of assetFacts) if (a.asm?.name === ref) return `${path}#${ref}`;
    return null;
  }
  function unityEventTargets(type: string | undefined, method: string, scriptGuid: string | undefined): string[] {
    if (!cs) return [];
    let types: TypeInfo[] = [];
    if (type) {
      const short = type.split(".").pop()!;
      types = cs.typesNamed(short).filter((t) => cs.fqnOf({ k: "in", t, args: [] }) === type);
    }
    if (!types.length && scriptGuid) {
      const id = scriptClass(scriptGuid, undefined);
      const t = id ? cs.byId.get(id) : undefined;
      if (t) types = [t];
    }
    // properties are set through their setter (`set_X`)
    const name = method.startsWith("set_") ? method.slice(4) : method;
    return types.flatMap((t) => cs.membersOf(t, name).map((m) => m.fact.id).filter(Boolean));
  }

  function animationEventTargets(clipNode: string, fn: string): string[] {
    if (!cs) return [];
    // Prefer scripts on GameObjects whose Animator plays this clip.
    const clipPath = byId.get(clipNode)?.path ?? clipNode;
    const clipGuid = metaOf.get(clipPath)?.guid;
    const controllers = new Set<string>();
    if (clipGuid) for (const [path, a] of assetFacts) if (a.motions?.some((m) => m.guid === clipGuid)) {
      const g = metaOf.get(path)?.guid;
      if (g) controllers.add(g);
    }
    const scoped: TypeInfo[] = [];
    for (const a of assetFacts.values()) for (const an of a.animators ?? []) {
      if (!an.controller || !controllers.has(an.controller.guid)) continue;
      for (const g of an.scripts) {
        const id = scriptClass(g, undefined);
        const t = id ? cs.byId.get(id) : undefined;
        if (t) scoped.push(t);
      }
    }
    // The engine calls the method on the Animator's own GameObject; when that
    // scripts list is unknown or has no such method (controllers swapped at run
    // time), fall back to every MonoBehaviour defining it — while that stays few.
    let hits = scoped.length ? methodsNamed(fn, scoped) : [];
    if (!hits.length) hits = methodsNamed(fn, null);
    return hits.length <= 8 ? hits : [];
  }

  function resolveCodeString(e: RawEdge, u0: CsUnityIntent): void {
    const u = u0;
    const op = u.op;
    // A string that comes whole from one constant (`LoadScene(SceneName)`): the
    // constant names the target too — callers of it should see what it names.
    const carrier = (() => {
      const first = u.args[0];
      if (!cs || !first || first.length !== 1 || first[0].length !== 1) return null;
      const part = first[0][0];
      if (!Array.isArray(part)) return null;
      const m = cs.memberOf(e.file, u.u, u.ty, e.source, part[1]);
      return m?.fact.id && m.fact.id !== e.source ? m.fact.id : null;
    })();
    const add = (source: string, target: string, relation: Relation, confidence: EdgeV1["confidence"] = "extracted", via?: string) => {
      addEdge(source, target, relation, confidence, via);
      if (carrier && source === e.source && (relation === "loads" || relation === "plays" || relation === "sets")) {
        addEdge(carrier, target, "references", confidence, via);
        const t = byId.get(target);
        const label = t ? (t.kind === "file" || t.kind === "asset" ? t.path : `${t.name} (${t.path})`) : target;
        const set = namesOf.get(carrier) ?? new Set<string>();
        set.add(label);
        namesOf.set(carrier, set);
      }
    };
    const { fqn, name: recvName } = recvInfo(e);
    const recvShort = (fqn ?? recvName ?? "").split(".").pop() ?? "";
    const via = (v: StrOut) => (/^#\d+$/.test(v.s) ? `build index ${v.s.slice(1)}` : `"${v.s}${v.open ? "…" : ""}"`);
    const each = (i: number, f: (v: StrOut) => void) => {
      for (const v of argStrings(e, i)) if (v.s || !v.open) f(v);
    };
    switch (op) {
      case "Load":
      case "LoadAll":
      case "LoadAsync":
        if (recvShort === "Resources")
          each(0, (v) => {
            for (const t of resourceTargets(v, u.targ, op === "LoadAll")) add(e.source, t, "loads", "extracted", `Resources.${op}(${via(v)})`);
          });
        return;
      case "Find":
        if (recvShort === "Shader")
          each(0, (v) => {
            if (v.open) return;
            const t = shaderNode(v.s);
            if (t) add(e.source, t, "loads", "extracted", `Shader.Find(${via(v)})`);
          });
        return;
      case "LoadSceneAsync":
        if (recvShort === "Addressables") {
          each(0, (v) => {
            if (v.open) return;
            for (const a of addresses.get(v.s) ?? []) {
              const t = assetTarget(a);
              if (t) add(e.source, t, "loads", "extracted", `Addressables.LoadSceneAsync(${via(v)})`);
            }
          });
          return;
        }
      // falls through
      case "LoadScene":
      case "GetSceneByName":
      case "UnloadSceneAsync":
      case "OpenScene":
        each(0, (v) => {
          for (const t of sceneTargets(v)) add(e.source, t, "loads", "extracted", `${recvShort || "SceneManager"}.${op}(${via(v)})`);
        });
        return;
      case "LoadAssetAtPath":
      case "LoadAllAssetsAtPath":
      case "LoadMainAssetAtPath":
      case "LoadPrefabContents":
      case "ImportAsset":
      case "AssetPathToGUID":
        each(0, (v) => {
          if (!/^(Assets|Packages|ProjectSettings)\//.test(v.s)) return;
          for (const t of pathTargets(v)) add(e.source, t, "loads", "extracted", `${recvShort || "AssetDatabase"}.${op}(${via(v)})`);
        });
        return;
      case "SetTrigger":
      case "ResetTrigger":
      case "SetBool":
      case "SetInteger":
      case "GetBool":
      case "GetInteger":
      case "IsParameterControlledByCurve":
      case "SetFloat":
      case "GetFloat": {
        const shaderish = /^(Material|MaterialPropertyBlock|Shader|ComputeShader|CommandBuffer)$/.test(recvShort);
        if (recvShort === "AudioMixer") {
          each(0, (v) => {
            if (v.open) return;
            for (const t of named("parameter", v.s).filter((n) => /\.mixer$/i.test(n.path))) add(e.source, t.id, op.startsWith("Set") ? "sets" : "references", "inferred", `AudioMixer.${op}(${via(v)})`);
          });
          return;
        }
        each(0, (v) => {
          if (v.open) return;
          const set = op.startsWith("Set") || op === "ResetTrigger";
          const isShader = shaderish || ((op === "SetFloat" || op === "GetFloat") && v.s.startsWith("_") && recvShort !== "Animator");
          const targets = isShader ? shaderProps(v.s) : named("parameter", v.s);
          for (const t of targets) add(e.source, t.id, set ? "sets" : "references", "inferred", `${op}(${via(v)})`);
        });
        return;
      }
      case "Play":
      case "CrossFade":
      case "CrossFadeInFixedTime":
      case "PlayInFixedTime":
      case "HasState": {
        if (recvShort && recvShort !== "Animator" && fqn) return; // AudioSource.Play etc. never take a state name
        each(0, (v) => {
          if (v.open) return;
          const short = v.s.includes(".") ? v.s.slice(v.s.lastIndexOf(".") + 1) : v.s;
          for (const t of named("state", short)) add(e.source, t.id, op === "HasState" ? "references" : "plays", "inferred", `${op}(${via(v)})`);
        });
        return;
      }
      case "StringToHash":
        each(0, (v) => {
          if (v.open) return;
          for (const t of [...named("parameter", v.s), ...named("state", v.s.split(".").pop()!)]) add(e.source, t.id, "references", "inferred", `StringToHash(${via(v)})`);
        });
        return;
      case "PropertyToID":
      case "SetColor":
      case "SetTexture":
      case "SetVector":
      case "SetInt":
      case "SetMatrix":
      case "SetBuffer":
      case "GetColor":
      case "GetTexture":
      case "GetVector":
      case "GetInt":
      case "HasProperty":
      case "HasFloat":
      case "HasColor":
      case "HasTexture":
      case "SetGlobalFloat":
      case "SetGlobalColor":
      case "SetGlobalTexture":
      case "SetGlobalVector":
      case "SetGlobalInt":
      case "SetGlobalMatrix":
        if (recvShort === "Animator") return;
        each(0, (v) => {
          if (v.open) return;
          for (const t of shaderProps(v.s)) add(e.source, t.id, op.startsWith("Set") ? "sets" : "references", "inferred", `${op}(${via(v)})`);
        });
        return;
      case "SendMessage":
      case "SendMessageUpwards":
      case "BroadcastMessage":
        each(0, (v) => {
          if (v.open) return;
          const hits = methodsNamed(v.s, null);
          if (hits.length <= 12) for (const t of hits) {
            add(e.source, t, "invokes", "inferred", `${op}(${via(v)})`);
            mark(t, `called by name via ${op}`);
          }
        });
        return;
      case "Invoke":
      case "InvokeRepeating":
      case "CancelInvoke":
      case "IsInvoking":
      case "StartCoroutine":
      case "StopCoroutine": {
        const t0 = cs && u.recv && !(u.recv[0] === "t") ? cs.typeOf(e.file, u.u, u.ty, e.source, u.recv) : null;
        const self = cs ? (u.ty ? (cs.byId.get(u.ty) ?? null) : cs.ownerTypeOf(e.source)) : null;
        const own = t0?.k === "in" ? [t0.t] : self ? [self] : null;
        each(0, (v) => {
          if (v.open) return;
          const hits = methodsNamed(v.s, own);
          const rel: Relation = op === "Invoke" || op === "InvokeRepeating" || op === "StartCoroutine" ? "invokes" : "references";
          for (const t of hits) add(e.source, t, rel, "inferred", `${op}(${via(v)})`);
        });
        return;
      }
      case "CompareTag":
      case "FindWithTag":
      case "FindGameObjectWithTag":
      case "FindGameObjectsWithTag":
      case "tag==":
        each(0, (v) => {
          if (v.open) return;
          for (const t of named("tag", v.s)) add(e.source, t.id, "references", "extracted", `${op}(${via(v)})`);
        });
        return;
      case "NameToLayer":
      case "GetMask":
        for (let i = 0; i < u.args.length; i++)
          each(i, (v) => {
            if (v.open) return;
            for (const t of named("layer", v.s)) add(e.source, t.id, "references", "extracted", `LayerMask.${op}(${via(v)})`);
          });
        return;
      case "path":
        // a literal "Assets/…" path anywhere in code: the asset or folder it names
        each(0, (v) => {
          for (const t of pathTargets(v)) {
            add(e.source, t, "references", "extracted", via(v));
            pathRefs.set(e.source, [...(pathRefs.get(e.source) ?? []), { t, via: via(v) }]);
          }
        });
        return;
      case "LoadAssetAsync":
      case "LoadAssetsAsync":
      case "InstantiateAsync":
      case "LoadResourceLocationsAsync":
        if (recvShort !== "Addressables" && recvShort !== "AssetReference") return;
        each(0, (v) => {
          if (v.open) return;
          for (const a of addresses.get(v.s) ?? []) {
            const t = assetTarget(a);
            if (t) add(e.source, t, "loads", "extracted", `Addressables.${op}(${via(v)})`);
          }
        });
        return;
      case "FindAction":
      case "FindActionMap":
        each(0, (v) => {
          if (v.open) return;
          const action = v.s.includes("/") ? v.s.slice(v.s.lastIndexOf("/") + 1) : v.s;
          if (op === "FindAction") for (const t of named("action", action)) add(e.source, t.id, "references", "inferred", `FindAction(${via(v)})`);
        });
        return;
      default:
        return;
    }
  }

  // A method using a path constant (`Prefabs = "Assets/…"`) names that asset too.
  for (const e of prior) {
    if (e.relation !== "references") continue;
    const refs = pathRefs.get(e.target);
    const field = byId.get(e.target);
    if (!refs || (field?.kind !== "constant" && field?.kind !== "field" && field?.kind !== "property")) continue;
    for (const r of refs) add(e.source, r.t, "references", "extracted", `${field.name} = ${r.via}`);
  }

  // ── a scene/prefab also carries what its nested prefabs (and variant bases) carry ──
  {
    const nested = new Map<string, Set<string>>(); // file → prefab files it nests/varies
    const carries = new Map<string, Set<string>>(); // file → classes attached in it
    const fileOf = (id: string) => byId.get(id)?.path ?? id;
    for (const e of out) {
      if (e.relation === "nests" || e.relation === "variant_of") {
        const from = fileOf(e.source);
        if (fileNodes.has(e.target)) (nested.get(from) ?? nested.set(from, new Set()).get(from)!).add(e.target);
      } else if (e.relation === "attaches" && byId.get(e.source)?.kind === "component") {
        const from = fileOf(e.source);
        (carries.get(from) ?? carries.set(from, new Set()).get(from)!).add(e.target);
      }
    }
    const memo = new Map<string, Map<string, string>>(); // file → class → nested prefab it comes through
    const through = (file: string, stack: Set<string>): Map<string, string> => {
      const m = memo.get(file);
      if (m) return m;
      const res = new Map<string, string>();
      memo.set(file, res);
      if (stack.has(file)) return res;
      stack.add(file);
      for (const p of nested.get(file) ?? []) {
        for (const c of carries.get(p) ?? []) if (!res.has(c)) res.set(c, p);
        for (const [c, via] of through(p, stack)) if (!res.has(c)) res.set(c, via);
      }
      stack.delete(file);
      return res;
    };
    for (const file of [...nested.keys()].sort()) {
      const own = carries.get(file) ?? new Set();
      for (const [cls, via] of through(file, new Set())) {
        if (!own.has(cls)) add(file, cls, "attaches", "extracted", `nested prefab ${basename(via)}`);
      }
    }
  }

  // ── what a component / asset points at, in its signature (callers and ask show it) ──
  {
    const assigned = new Map<string, string[]>();
    for (const e of out) {
      if (e.relation !== "assigns" || !e.via) continue;
      const src = byId.get(e.source);
      if (!src || (src.kind !== "component" && !(src.kind === "file" && /\.asset$/i.test(src.path)))) continue;
      const t = byId.get(e.target);
      const field = e.via.split(", ")[0].replace(/^.*?\b(\w+)$/, "$1");
      const list = assigned.get(e.source) ?? [];
      // an object in the same scene/prefab is named by its hierarchy path, an asset by its path
      const goPath = t?.kind === "component" ? `"${/ on "(.*?)"/.exec(t.signature ?? "")?.[1] ?? t.name}"` : "";
      const where = !t ? e.target : t.kind !== "component" ? t.path : t.path === src.path ? goPath : `${t.path} ${goPath}`;
      if (list.length < 3) list.push(`${field} → ${where}`);
      assigned.set(e.source, list);
    }
    for (const [id, list] of assigned) {
      const n = byId.get(id)!;
      n.signature = `${n.signature ?? ""} · ${list.join(" · ")}`;
    }
    for (const e of out) {
      if (e.relation !== "variant_of") continue;
      const n = byId.get(e.source);
      if (n && n.kind === "file") n.signature = `${n.signature ?? ""} of ${byId.get(e.target)?.path ?? e.target}`;
    }
  }

  // ── assemblies: which asmdef compiles which C# file ──
  const asmDirs: Array<{ dir: string; id: string }> = [];
  for (const [path, a] of assetFacts) if (a.asm) asmDirs.push({ dir: dirname(path), id: `${path}#${a.asm.name}` });
  for (const [dir, id] of asmrefTargets) asmDirs.push({ dir, id });
  asmDirs.sort((x, y) => y.dir.length - x.dir.length);
  const unowned: { runtime: string[]; editor: string[] } = { runtime: [], editor: [] };
  const asmOf = new Map<string, string>(); // .cs file → "Assembly (asmdef path)"
  for (const id of fileNodes) {
    if (!id.toLowerCase().endsWith(".cs")) continue;
    if (!/^(Assets|Packages)\//.test(id)) continue;
    if (!metaOf.size) break; // not a Unity project: no predefined assemblies to speak of
    const owner = asmDirs.find((a) => id.startsWith(`${a.dir}/`));
    if (owner) {
      if (byId.has(owner.id)) add(owner.id, id, "compiles", "extracted");
      const asmNode = byId.get(owner.id);
      if (asmNode) asmOf.set(id, `${asmNode.name} (${asmNode.path})`);
    } else if (id.startsWith("Assets/")) {
      (/(^|\/)Editor\//.test(id) ? unowned.editor : unowned.runtime).push(id);
    }
  }
  for (const [kind, files] of Object.entries(unowned)) {
    if (!files.length) continue;
    const name = kind === "editor" ? "Assembly-CSharp-Editor" : "Assembly-CSharp";
    const id = `Assets#${name}`;
    const listed = files.slice(0, 12).join(", ") + (files.length > 12 ? `, … (${files.length})` : "");
    const n: NodeV1 = {
      id,
      name,
      kind: "module",
      path: "Assets",
      span: "L1-L1",
      signature: `assembly ${name} (scripts under Assets/ without an asmdef): ${listed}`,
      exported: true,
      origin: "ast",
      body_hash: contentHash(files.join("\n")),
      body_text: `${name} predefined assembly no asmdef ${files.join(" ")}`,
      summary_state: "pending",
      summary: null,
      crux: null,
    };
    nodes.push(n);
    byId.set(id, n);
    for (const f of files) {
      add(id, f, "compiles", "extracted");
      asmOf.set(f, `${name} (no asmdef)`);
    }
  }
  // one answer to "which scripts have no asmdef": each predefined assembly names the other's too
  const rt = byId.get("Assets#Assembly-CSharp");
  const ed = byId.get("Assets#Assembly-CSharp-Editor");
  if (rt && ed) {
    rt.signature = `${rt.signature} · Editor-folder scripts → Assembly-CSharp-Editor: ${unowned.editor.slice(0, 12).join(", ")}`;
    ed.signature = `${ed.signature} · other scripts → Assembly-CSharp: ${unowned.runtime.slice(0, 12).join(", ")}`;
  }
  for (const n of nodes) {
    if (n.kind === "file" || n.kind === "class" || n.kind === "struct" || n.kind === "interface" || n.kind === "enum" || n.kind === "type") {
      const a = asmOf.get(n.path);
      if (a) n.asm = a;
    }
  }

  // ── Input System: generated wrapper classes, PlayerInput messages ──
  if (cs) {
    for (const [asset, meta] of metaOf) {
      if (!meta.wrapper || !fileNodes.has(asset)) continue;
      const af = assetFacts.get(asset);
      const clsName = meta.wrapper.cls ?? basename(asset, extname(asset)).replace(/[^\w]/g, "");
      const types = cs.typesNamed(clsName).filter((t) => !meta.wrapper!.ns || t.ns === meta.wrapper!.ns);
      const wrapper = types[0];
      if (!wrapper) continue;
      add(asset, wrapper.id, "references", "extracted", "generated C# wrapper");
      for (const m of af?.maps ?? []) {
        const mapType = cs.typesNamed(`${typeName(m.name)}Actions`).find((t) => t.outer === wrapper);
        const iface = cs.typesNamed(`I${typeName(m.name)}Actions`).find((t) => t.outer === wrapper);
        for (const a of m.actions) {
          const actionNode = `${asset}#${m.name}/${a}`;
          if (!byId.has(actionNode)) continue;
          const prop = mapType ? cs.membersOf(mapType, identifier(a)) : [];
          for (const p of prop) if (p.fact.id) add(actionNode, p.fact.id, "references", "extracted", "generated accessor");
          // callback interface: implementations of On<Action>
          if (iface) for (const t of cs.types) {
            if (!cs.baseChain(t).some((b) => b.k === "in" && b.t === iface)) continue;
            for (const mm of cs.membersOf(t, `On${typeName(a)}`)) if (mm.fact.id && mm.owner === t) {
              add(actionNode, mm.fact.id, "invokes", "extracted", `I${typeName(m.name)}Actions callback`);
              mark(mm.fact.id, `Input System callback for action ${m.name}/${a}`);
            }
          }
        }
      }
    }
    for (const [, af] of assetFacts) for (const pi of af.playerInputs ?? []) {
      if (!pi.actions || pi.behavior > 1) continue;
      const path = guidToPath.get(pi.actions.guid);
      const maps = path ? assetFacts.get(path)?.maps : undefined;
      if (!maps) continue;
      const scripts = pi.scripts.map((g) => scriptClass(g, undefined)).map((id) => (id ? cs.byId.get(id) : undefined)).filter((t): t is TypeInfo => !!t);
      for (const m of maps) for (const a of m.actions) {
        const msg = `On${typeName(a)}`;
        for (const t of scripts) for (const mm of cs.membersOf(t, msg)) if (mm.fact.id) {
          add(`${path}#${m.name}/${a}`, mm.fact.id, "invokes", "extracted", `PlayerInput ${pi.behavior === 1 ? "BroadcastMessages" : "SendMessages"}`);
          mark(mm.fact.id, `PlayerInput message for action ${a}`);
        }
      }
      for (const t of scripts) for (const msg of ["OnDeviceLost", "OnDeviceRegained", "OnControlsChanged"]) for (const mm of cs.membersOf(t, msg)) mark(mm.fact.id, `PlayerInput message ${msg}`);
    }
  }

  // ── engine entry points ──
  if (cs) {
    const messages = cs.api.messages;
    for (const t of cs.types) {
      const chain = cs.baseChain(t);
      const ext = chain.filter((b) => b.k === "ex").map((b) => cs.fqnOf(b));
      const msgSets = ext.filter((f) => messages[f]).map((f) => ({ base: f, names: new Set(messages[f]) }));
      for (const [name, ms] of t.members) {
        for (const m of ms) {
          if (!m.fact.id || m.owner !== t) continue;
          if (m.fact.mk === "method") {
            const base = msgSets.find((s) => s.names.has(name));
            if (base) mark(m.fact.id, `Unity message ${name} (${base.base.split(".").pop()})`);
          }
          entryFromAttrs(m.fact, m.fact.id);
        }
      }
      // [InitializeOnLoad] runs the static constructor
      if (t.facts.some((f) => f.attrs?.some((a) => a.n === "InitializeOnLoad"))) {
        for (const m of t.members.get(t.name) ?? []) if (m.fact.mk === "cctor") mark(m.fact.id, "Unity Editor runs it on load [InitializeOnLoad]");
        mark(t.id, "Unity Editor loads it at startup [InitializeOnLoad]");
      }
      for (const f of t.facts) for (const a of f.attrs ?? []) {
        if (a.n === "CreateAssetMenu") mark(t.id, `Unity Editor "Create" menu${a.a?.length ? ` (${a.a.join(", ")})` : ""} [CreateAssetMenu]`);
        if (a.n === "CustomEditor" || a.n === "CustomPropertyDrawer" || a.n === "CustomEditorForRenderPipeline") {
          mark(t.id, `Unity Editor instantiates it [${a.n}]`);
          for (const arg of a.a ?? []) if (arg.startsWith("typeof:")) {
            const tv = cs.resolveTypeIn(t.files[0], f.u, t.id, arg.slice(7));
            if (tv?.k === "in") add(t.id, tv.t.id, "references", "extracted", `[${a.n}]`);
          }
        }
        if (a.n === "RequireComponent") for (const arg of a.a ?? []) if (arg.startsWith("typeof:")) {
          const tv = cs.resolveTypeIn(t.files[0], f.u, t.id, arg.slice(7));
          if (tv?.k === "in") add(t.id, tv.t.id, "references", "extracted", "[RequireComponent]");
        }
        if (a.n === "TestFixture") mark(t.id, "NUnit test fixture [TestFixture]");
      }
      // overrides of engine virtuals and engine callback interfaces
      for (const iface of ext.filter((f) => CALLBACK_IFACE.test(f))) {
        const api = cs.api.types[iface];
        // EventSystems handlers are named after their one method: IPointerClickHandler → OnPointerClick
        const handler = /^UnityEngine\.EventSystems\.I(\w+)Handler$/.exec(iface)?.[1];
        const names = [...Object.keys(api?.m ?? {}), ...(handler ? [`On${handler}`] : [])];
        for (const name of names) for (const m of t.members.get(name) ?? []) if (m.fact.id) mark(m.fact.id, `${iface.split(".").pop()} callback (EventSystem/engine)`);
      }
    }
    for (const e of [...prior, ...out]) {
      if (e.relation !== "overrides" || byId.has(e.target)) continue;
      if (/^Unity(Engine|Editor)\./.test(e.target)) mark(e.source, `Unity calls it (overrides ${e.target})`);
    }
    for (const x of opts.executeMethods ?? []) {
      const dot = x.method.lastIndexOf(".");
      if (dot < 0) continue;
      const typeFqn = x.method.slice(0, dot);
      const mname = x.method.slice(dot + 1);
      const types = cs.typesNamed(typeFqn.split(".").pop()!).filter((t) => cs.fqnOf({ k: "in", t, args: [] }) === typeFqn);
      for (const t of types) for (const m of cs.membersOf(t, mname)) mark(m.fact.id, `Unity batchmode -executeMethod ${x.method} (${x.file}:${x.line})`);
    }
  }

  function entryFromAttrs(f: CsMemberFact, id: string): void {
    for (const a of f.attrs ?? []) {
      if (a.n === "MenuItem") {
        const p = a.a?.[0];
        const validate = a.a?.[1] === "true";
        if (p) mark(id, validate ? `Unity Editor menu validator "${p}" [MenuItem]` : `Unity Editor menu "${p}" [MenuItem]`);
      } else if (a.n === "ContextMenu") {
        const p = a.a?.[0];
        if (p) mark(id, `Inspector context menu "${p}" [ContextMenu]`);
      } else if (a.n === "ContextMenuItem") {
        const target = a.a?.[1];
        if (target && cs) {
          const owner = cs.memberById.get(id)?.owner;
          for (const m of owner ? cs.membersOf(owner, target) : []) mark(m.fact.id, `Inspector field context menu "${a.a?.[0]}" [ContextMenuItem]`);
        }
      } else if (ENTRY_ATTRS[a.n]) {
        mark(id, `${ENTRY_ATTRS[a.n]}${a.a?.length && a.n === "RuntimeInitializeOnLoadMethod" ? ` (${a.a.join(", ")})` : ""}`);
      }
    }
  }

  for (const [id, whys] of entries) {
    const n = byId.get(id);
    if (n) n.entry = [...whys].sort().join("; ");
  }
  for (const [id, set] of namesOf) {
    const n = byId.get(id);
    if (n) n.names = [...set].sort().slice(0, 6).join(", ");
  }
  return out;
}

/** Input System's CSharpCodeHelpers.MakeIdentifier: letters/digits/underscore only,
 * a leading digit prefixed with `_`. */
export function identifier(name: string): string {
  let s = name.replace(/[^\p{L}\p{N}_]/gu, "");
  if (/^\d/.test(s)) s = `_${s}`;
  return s;
}

/** CSharpCodeHelpers.MakeTypeName: MakeIdentifier with the first letter upper-cased. */
export function typeName(name: string): string {
  const s = identifier(name);
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}
