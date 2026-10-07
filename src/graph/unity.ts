/**
 * Unity asset layer — per-file extraction of the text assets a Unity project is
 * wired with. Code decides *how* things behave; these files decide *which* code
 * runs where: a scene carries components, a prefab nests prefabs, a button's
 * UnityEvent names a method, a material names a shader, an Animator state names a
 * clip and a StateMachineBehaviour, a `.meta` gives every asset the GUID all of
 * those references use.
 *
 * Like every extractor, this is pure and file-local (cached per file). References
 * that cross files — a GUID, a script, a class/method named in a UnityEvent, a
 * shader name — are emitted as {@link UnityIntent}s with the file's
 * {@link UnityFacts}; unity-resolve.ts settles them against the whole project.
 * References inside one file (`{fileID: N}`) are settled here.
 *
 * Formats follow the Unity 6000.6 manual (UnityYAML, ClassID reference, `.meta`,
 * asmdef format), Input System 1.20 (`.inputactions` JSON, generated wrapper),
 * ShaderLab. See unity-yaml.ts for the YAML subset.
 */
import { basename, dirname, extname, posix } from "node:path";
import { contentHash } from "../util/id.js";
import type { ExtractResult, RawEdge } from "./extract.js";
import type { Kind, NodeV1, Relation } from "./types.js";
import { itemsOf, parseRef, scanUnityYaml, type UDoc } from "./unity-yaml.js";

// ── facts & intents ─────────────────────────────────────────────────────────

export interface GuidRef {
  guid: string;
  fid?: string;
}

export type UnityIntent =
  | { k: "script"; guid?: string; fid?: string; cls?: string } // attaches (GO / state → MonoBehaviour / StateMachineBehaviour)
  | { k: "asset"; guid: string; fid?: string; via: string; rel?: Relation } // assigns (or rel) → asset
  | { k: "prefab"; guid: string; via: string } // nests
  | { k: "variant"; guid: string } // variant_of
  | { k: "so"; guid: string; fid?: string; cls?: string } // instance_of
  | { k: "shader"; guid?: string; fid?: string; name?: string; via?: string } // uses_shader / references by name
  | { k: "call"; type?: string; method: string; via: string; script?: string } // invokes (UnityEvent)
  | { k: "animevent"; fn: string; clip?: string } // invokes (AnimationEvent)
  | { k: "tag"; name: string } // references a tag
  | { k: "layer"; index?: number; name?: string; via?: string } // references a layer
  | { k: "include"; path: string } // imports (shader include, uss/uxml import)
  | { k: "asmref"; ref: string; rel: "imports" | "compiles" } // assembly reference
  | { k: "scene"; guid?: string; path: string; via: string }; // EditorBuildSettings → scene

export interface AnimatorFact {
  go: string; // GameObject node id
  controller?: GuidRef;
  scripts: string[]; // script guids on the same GameObject
}

export interface PlayerInputFact {
  go: string;
  actions?: GuidRef;
  behavior: number; // 0 SendMessages, 1 BroadcastMessages, 2 UnityEvents, 3 C# events
  scripts: string[];
}

export interface UnityFacts {
  /** `.meta`: the asset this meta describes and its GUID. */
  meta?: {
    guid: string;
    asset: string; // repo-relative asset path
    folder?: true;
    importer?: string;
    /** Input System ScriptedImporter: the generated wrapper class. */
    wrapper?: { path?: string; cls?: string; ns?: string };
    /** ScriptedImporter / MonoImporter script and the like. */
    script?: GuidRef;
  };
  /** What kind of asset the file is and what the resolver needs from it. */
  asset?: {
    kind: string; // scene, prefab, asset, material, controller, clip, inputactions, asmdef, asmref, shader, shadergraph, uss, uxml, …
    /** prefab: object fileID → node id, for cross-file `{fileID, guid}` refs into it. */
    objects?: Record<string, string>;
    root?: string; // prefab root GameObject node id
    animators?: AnimatorFact[];
    playerInputs?: PlayerInputFact[];
    /** controller: clips its states play, parameter and state names. */
    motions?: GuidRef[];
    /** shader / shadergraph: the name `Shader.Find` and materials use. */
    shaderName?: string;
    /** asmdef: assembly identity. */
    asm?: { name: string; rootNs?: string; editor?: boolean; test?: boolean };
    /** inputactions: map → actions. */
    maps?: Array<{ name: string; actions: string[] }>;
    /** EditorBuildSettings: scenes in build order. */
    scenes?: Array<{ path: string; guid?: string; enabled: boolean }>;
    /** TagManager: layer index → name. */
    layers?: string[];
    tags?: string[];
    /** Addressables group: address (and labels) → asset GUID. */
    addresses?: Array<{ address: string; guid: string; labels?: string[] }>;
  };
}

// ── file kinds ──────────────────────────────────────────────────────────────

const YAML_KINDS: Record<string, string> = {
  ".unity": "scene",
  ".prefab": "prefab",
  ".asset": "asset",
  ".mat": "material",
  ".controller": "controller",
  ".overridecontroller": "overrideController",
  ".anim": "clip",
  ".mask": "mask",
  ".playable": "playable",
  ".mixer": "mixer",
  ".signal": "signal",
  ".physicmaterial": "physicMaterial",
  ".physicsmaterial2d": "physicMaterial",
  ".lighting": "lighting",
  ".rendertexture": "renderTexture",
  ".spriteatlas": "spriteAtlas",
  ".spriteatlasv2": "spriteAtlas",
  ".preset": "preset",
  ".terrainlayer": "terrainLayer",
  ".flare": "flare",
  ".guiskin": "guiSkin",
  ".fontsettings": "fontSettings",
  ".cubemap": "cubemap",
  ".brush": "brush",
  ".giparams": "giParams",
  ".shadervariants": "shaderVariants",
  ".vfx": "vfx",
  ".vfxoperator": "vfx",
  ".vfxblock": "vfx",
};
const OTHER_KINDS: Record<string, string> = {
  ".meta": "meta",
  ".inputactions": "inputactions",
  ".asmdef": "asmdef",
  ".asmref": "asmref",
  ".shader": "shader",
  ".hlsl": "shader",
  ".cginc": "shader",
  ".compute": "shader",
  ".glslinc": "shader",
  ".shadergraph": "shadergraph",
  ".shadersubgraph": "shadergraph",
  ".uss": "uss",
  ".tss": "uss",
  ".uxml": "uxml",
};

/** Extensions the Unity layer claims. */
export function unityExtensions(): string[] {
  return [...Object.keys(YAML_KINDS), ...Object.keys(OTHER_KINDS)];
}

export function unityKindOf(path: string): string | null {
  const ext = extname(path).toLowerCase();
  return YAML_KINDS[ext] ?? OTHER_KINDS[ext] ?? null;
}

/** Display label for the build banner. */
export function unityLabelOf(path: string): string | null {
  const k = unityKindOf(path);
  if (!k) return null;
  if (k === "shader" || k === "shadergraph") return "shaderlab";
  if (k === "uss" || k === "uxml") return "ui-toolkit";
  return "unity";
}

// ── helpers ─────────────────────────────────────────────────────────────────

const MAX_BODY = 5000;
function body(text: string, max = MAX_BODY): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max) : t;
}

function fileNode(rel: string, source: string, signature: string | null, bodyText: string): NodeV1 {
  const lines = source.length ? source.split("\n").length : 1;
  return {
    id: rel,
    name: basename(rel),
    kind: "file",
    path: rel,
    span: `L1-L${Math.max(1, lines)}`,
    signature,
    exported: true,
    origin: "ast",
    body_hash: contentHash(source),
    chars: source.length,
    body_text: body(bodyText, 16000),
    summary_state: "pending",
    summary: null,
    crux: null,
  };
}

interface Out {
  rel: string;
  nodes: NodeV1[];
  edges: RawEdge[];
  minted: Set<string>;
  pkg?: string;
}

function mint(o: Out, part: string): string {
  const base = `${o.rel}#${part}`;
  let id = base;
  let k = 2;
  while (o.minted.has(id)) id = `${base}~${k++}`;
  o.minted.add(id);
  return id;
}

function addNode(o: Out, part: string, name: string, kind: Kind, startLine: number, endLine: number, signature: string, bodyText: string, parent?: string): string {
  const id = mint(o, part);
  o.nodes.push({
    id,
    name: name || "(unnamed)",
    kind,
    path: o.rel,
    span: `L${startLine + 1}-L${Math.max(startLine, endLine) + 1}`,
    signature,
    exported: true,
    origin: "ast",
    body_hash: contentHash(`${id}\n${bodyText}`),
    body_text: body(bodyText),
    summary_state: "pending",
    summary: null,
    crux: null,
    ...(o.pkg ? { pkg: o.pkg } : {}),
  });
  o.edges.push({ source: parent ?? o.rel, relation: "contains", targetId: id, file: o.rel });
  return id;
}

function intent(o: Out, source: string, relation: Relation, unity: UnityIntent): void {
  o.edges.push({ source, relation, file: o.rel, unity });
}

function local(o: Out, source: string, relation: Relation, targetId: string): void {
  if (source !== targetId) o.edges.push({ source, relation, file: o.rel, targetId });
}

function packageOf(rel: string): string | undefined {
  const m = rel.match(/^Packages\/([^/]+)\//);
  return m ? m[1] : undefined;
}

const BUILTIN_TAGS = ["Untagged", "Respawn", "Finish", "EditorOnly", "MainCamera", "Player", "GameController"];

/** Standard MonoBehaviour/ScriptableObject header keys — not serialized user fields. */
const STD_KEYS = new Set([
  "m_ObjectHideFlags", "m_CorrespondingSourceObject", "m_PrefabInstance", "m_PrefabAsset", "m_GameObject", "m_Enabled",
  "m_EditorHideFlags", "m_Script", "m_Name", "m_EditorClassIdentifier", "serializedVersion",
]);

/** `Game.Runtime::Hordefall.Art.ZombieLooks` → `Hordefall.Art.ZombieLooks`. */
function classIdentifier(doc: UDoc): string | undefined {
  const v = doc.props.m_EditorClassIdentifier;
  if (!v) return undefined;
  const t = v.includes("::") ? v.slice(v.indexOf("::") + 2) : v;
  return t.trim() || undefined;
}

// ── entry point ─────────────────────────────────────────────────────────────

export function extractUnity(rel: string, source: string): ExtractResult & { facts: { unity: UnityFacts } } {
  const kind = unityKindOf(rel) ?? "asset";
  const o: Out = { rel, nodes: [], edges: [], minted: new Set([rel]), pkg: packageOf(rel) };
  if (kind === "meta") return { nodes: [], rawEdges: [], facts: { unity: extractMeta(rel, source, o) } };
  let facts: UnityFacts;
  switch (kind) {
    case "scene":
    case "prefab":
      facts = extractSceneOrPrefab(rel, source, o, kind);
      break;
    case "controller":
      facts = extractController(rel, source, o);
      break;
    case "inputactions":
      facts = extractInputActions(rel, source, o);
      break;
    case "asmdef":
    case "asmref":
      facts = extractAsmdef(rel, source, o, kind);
      break;
    case "shader":
      facts = extractShader(rel, source, o);
      break;
    case "shadergraph":
      facts = extractShaderGraph(rel, source, o);
      break;
    case "uss":
    case "uxml":
      facts = extractUi(rel, source, o, kind);
      break;
    default:
      facts = extractYamlAsset(rel, source, o, kind);
  }
  if (o.pkg) for (const n of o.nodes) n.pkg = o.pkg;
  return { nodes: o.nodes, rawEdges: o.edges, facts: { unity: facts } };
}

// ── .meta ───────────────────────────────────────────────────────────────────

function extractMeta(rel: string, source: string, o: Out): UnityFacts {
  if (!source.startsWith("fileFormatVersion")) return {};
  const [doc] = scanUnityYaml(source);
  const guid = doc?.props.guid?.toLowerCase();
  if (!doc || !guid) return {};
  const asset = rel.replace(/\.meta$/i, "");
  const meta: NonNullable<UnityFacts["meta"]> = { guid, asset };
  if (doc.props.folderAsset === "yes") meta.folder = true;
  if (doc.type) meta.importer = doc.type;
  const script = parseRef(doc.props.script);
  if (script?.guid) meta.script = { guid: script.guid, fid: script.fid };
  if (doc.props.generateWrapperCode === "1") {
    meta.wrapper = {};
    if (doc.props.wrapperCodePath) meta.wrapper.path = doc.props.wrapperCodePath;
    if (doc.props.wrapperClassName) meta.wrapper.cls = doc.props.wrapperClassName;
    if (doc.props.wrapperCodeNamespace) meta.wrapper.ns = doc.props.wrapperCodeNamespace;
  }
  // ModelImporter: animation events on the clips it imports
  for (const ev of itemsOf(doc, "events")) {
    const fn = ev.v.functionName;
    if (fn) intent(o, asset, "invokes", { k: "animevent", fn });
  }
  // ModelImporter remaps embedded materials onto project materials
  for (const r of doc.refs) {
    if (r.guid && /externalObjects/.test(r.path)) intent(o, asset, "assigns", { k: "asset", guid: r.guid, fid: r.fid, via: "externalObjects" });
  }
  // a meta has no nodes of its own; any intents hang off the asset node the resolver mints
  return { meta };
}

// ── scenes & prefabs ────────────────────────────────────────────────────────

const TRANSFORM = new Set([4, 224]);
const GAMEOBJECT = 1;
const MONOBEHAVIOUR = 114;
const ANIMATOR = 95;
const PREFAB_INSTANCE = 1001;

function extractSceneOrPrefab(rel: string, source: string, o: Out, kind: "scene" | "prefab"): UnityFacts {
  const docs = scanUnityYaml(source);
  const byId = new Map(docs.map((d) => [d.fileId, d]));
  const gos = docs.filter((d) => d.classId === GAMEOBJECT);
  const components = new Map<string, UDoc[]>(); // GameObject fileId → its components
  for (const d of docs) {
    const go = parseRef(d.props.m_GameObject)?.fid;
    if (go && go !== "0") {
      const list = components.get(go) ?? [];
      list.push(d);
      components.set(go, list);
    }
  }
  const transformOf = (go: string) => components.get(go)?.find((c) => TRANSFORM.has(c.classId));
  const fatherOf = (go: string) => parseRef(transformOf(go)?.props.m_Father)?.fid;
  const instances = docs.filter((d) => d.classId === PREFAB_INSTANCE);
  const instanceName = (pi: UDoc): string => {
    for (const it of itemsOf(pi, "m_Modifications")) if (it.v.propertyPath === "m_Name" && it.v.value) return it.v.value;
    return "(prefab instance)";
  };
  const instanceParent = (pi: UDoc): string | undefined => {
    const f = pi.refs.find((r) => r.path.endsWith("m_TransformParent"))?.fid;
    return f && f !== "0" ? f : undefined;
  };

  // Hierarchy paths ("Canvas/Panel/Play"), through nested prefab instances.
  const pathMemo = new Map<string, string>();
  const instancePath = (pi: UDoc, depth: number): string => {
    const parent = transformPath(instanceParent(pi), depth + 1);
    return parent ? `${parent}/${instanceName(pi)}` : instanceName(pi);
  };
  const transformPath = (tf: string | undefined, depth = 0): string => {
    if (!tf || tf === "0" || depth > 64) return "";
    const t = byId.get(tf);
    if (!t) return "";
    if (t.stripped) {
      const pi = byId.get(parseRef(t.props.m_PrefabInstance)?.fid ?? "");
      return pi ? instancePath(pi, depth) : "";
    }
    const go = parseRef(t.props.m_GameObject)?.fid;
    return go ? goPath(go, depth + 1) : "";
  };
  const goPath = (go: string, depth = 0): string => {
    const memo = pathMemo.get(go);
    if (memo !== undefined) return memo;
    pathMemo.set(go, "");
    const g = byId.get(go);
    let p = "";
    if (g?.stripped) {
      const pi = byId.get(parseRef(g.props.m_PrefabInstance)?.fid ?? "");
      if (pi) p = instancePath(pi, depth);
    } else if (g) {
      const parent = transformPath(fatherOf(go), depth + 1);
      const name = g.name ?? "(unnamed)";
      p = parent ? `${parent}/${name}` : name;
    }
    pathMemo.set(go, p);
    return p;
  };
  const goOf = (fid: string): string | undefined => {
    const d = byId.get(fid);
    if (!d) return undefined;
    if (d.classId === GAMEOBJECT) return d.fileId;
    return parseRef(d.props.m_GameObject)?.fid;
  };

  const prefabRoot = kind === "prefab" ? gos.find((g) => !g.stripped && (!fatherOf(g.fileId) || fatherOf(g.fileId) === "0")) : undefined;
  // A variant: a prefab whose root is itself a prefab instance with no parent.
  let variantBase: string | undefined;
  if (kind === "prefab" && !prefabRoot) {
    const rootPi = instances.find((pi) => !instanceParent(pi));
    variantBase = parseRef(rootPi?.props.m_SourcePrefab)?.guid;
  }

  // One node per script/Animator component: its own document is the exact span a
  // reference or a UnityEvent sits in. Plain components (renderers, colliders) get
  // no node; their references hang off the file.
  const objects: Record<string, string> = {};
  const compNode = new Map<string, string>(); // component fileId → node id
  const goFirstNode = new Map<string, string>(); // GameObject fileId → first component node id
  const animators: AnimatorFact[] = [];
  const playerInputs: PlayerInputFact[] = [];
  const fileBody: string[] = [];
  const shortOf = (d: UDoc): string => (d.classId === MONOBEHAVIOUR ? (classIdentifier(d)?.split(".").pop() ?? "MonoBehaviour") : d.type);
  for (const g of gos) if (!g.stripped) fileBody.push(goPath(g.fileId));
  for (const d of docs) {
    if (d.stripped || (d.classId !== MONOBEHAVIOUR && d.classId !== ANIMATOR)) continue;
    const go = parseRef(d.props.m_GameObject)?.fid;
    if (!go) continue;
    const path = goPath(go) || "(unnamed)";
    const short = shortOf(d);
    const goName = path.split("/").pop() ?? path;
    const fields: string[] = [];
    for (const [k, v] of Object.entries(d.props)) if (!STD_KEYS.has(k) && !v.startsWith("{fileID")) fields.push(`${k}=${v}`);
    const cls = d.classId === MONOBEHAVIOUR ? classIdentifier(d) : undefined;
    const id = addNode(
      o,
      `${path}:${short}`,
      goName,
      "component",
      d.start,
      d.end,
      `${short} on "${path}"`,
      `${path} ${short} ${cls ?? ""} ${fields.join(" ")}`,
    );
    compNode.set(d.fileId, id);
    objects[d.fileId] = id;
    if (!goFirstNode.has(go)) {
      goFirstNode.set(go, id);
      objects[go] = id;
    }
  }
  // other components of a GameObject with a node resolve to that node
  for (const [go, comps] of components) {
    const n = goFirstNode.get(go);
    if (n) for (const c of comps) objects[c.fileId] ??= n;
  }
  const nodeFor = (fid: string): string | undefined => compNode.get(fid) ?? (goOf(fid) ? goFirstNode.get(goOf(fid)!) : undefined);

  const callRefs = new Set<number>();
  for (const d of docs) {
    if (d.classId === GAMEOBJECT || TRANSFORM.has(d.classId) || d.classId === PREFAB_INSTANCE || d.stripped) continue;
    const goFid = parseRef(d.props.m_GameObject)?.fid;
    const src = compNode.get(d.fileId) ?? rel;
    const path = goFid ? goPath(goFid) : "";
    const short = shortOf(d);
    if (d.classId === MONOBEHAVIOUR) {
      const script = parseRef(d.props.m_Script);
      const cls = classIdentifier(d);
      if (script?.guid || cls) intent(o, src, "attaches", { k: "script", guid: script?.guid, fid: script?.fid, ...(cls ? { cls } : {}) });
      if (d.props.m_NotificationBehavior !== undefined) {
        const actions = d.refs.find((r) => r.path === "m_Actions");
        playerInputs.push({
          go: src,
          actions: actions?.guid ? { guid: actions.guid, fid: actions.fid } : undefined,
          behavior: Number(d.props.m_NotificationBehavior) || 0,
          scripts: [],
        });
      }
    }
    if (d.classId === ANIMATOR) {
      const ctrl = d.refs.find((r) => r.path === "m_Controller");
      animators.push({ go: src, controller: ctrl?.guid ? { guid: ctrl.guid, fid: ctrl.fid } : undefined, scripts: [] });
    }
    layerMaskRefs(d, src, o);
    // UnityEvent persistent calls
    callRefs.clear();
    for (const c of itemsOf(d, "m_Calls")) {
      callRefs.add(c.id);
      const method = c.v.m_MethodName;
      if (!method) continue;
      const event = c.list.split(".")[0];
      const target = parseRef(c.v.m_Target);
      const tdoc = target?.fid ? byId.get(target.fid) : undefined;
      const tscript = tdoc?.classId === MONOBEHAVIOUR ? parseRef(tdoc.props.m_Script)?.guid : undefined;
      const type = c.v.m_TargetAssemblyTypeName?.split(",")[0]?.trim();
      intent(o, src, "invokes", { k: "call", method, via: `${path ? `${path}.` : ""}${short}.${event}`, ...(type ? { type } : {}), ...(tscript ? { script: tscript } : {}) });
    }
    // serialized references
    for (const r of d.refs) {
      if (callRefs.has(r.item)) continue; // UnityEvent targets are handled above
      if (r.guid === "0000000000000000e000000000000000" || r.guid === "0000000000000000f000000000000000") continue; // built-in resources
      const via = src === rel && path ? `${path}.${short}.${r.path}` : `${short}.${r.path}`;
      if (r.guid) intent(o, src, "assigns", { k: "asset", guid: r.guid, fid: r.fid, via });
      else {
        const t = nodeFor(r.fid);
        if (t && t !== src) o.edges.push({ source: src, relation: "assigns", file: rel, targetId: t, unity: { k: "asset", guid: "", via } });
      }
    }
  }
  // scripts per node, for animation events and PlayerInput messages
  const scriptsOn = new Map<string, string[]>();
  for (const d of docs) {
    if (d.classId !== MONOBEHAVIOUR) continue;
    const go = parseRef(d.props.m_GameObject)?.fid;
    const g = parseRef(d.props.m_Script)?.guid;
    if (!go || !g) continue;
    for (const c of components.get(go) ?? []) {
      const n = compNode.get(c.fileId);
      if (n) scriptsOn.set(n, [...(scriptsOn.get(n) ?? []), g]);
    }
  }
  for (const a of animators) a.scripts = scriptsOn.get(a.go) ?? [];
  for (const p of playerInputs) p.scripts = scriptsOn.get(p.go) ?? [];

  // tags and layers of GameObjects (the file carries them; via names the object)
  for (const g of gos) {
    if (g.stripped) continue;
    const tag = g.props.m_TagString;
    const src = goFirstNode.get(g.fileId) ?? rel;
    if (tag && tag !== "Untagged") intent(o, src, "references", { k: "tag", name: tag });
    const layer = Number(g.props.m_Layer);
    if (layer > 0) intent(o, src, "references", { k: "layer", index: layer });
  }

  // nested prefab instances (and their reference overrides)
  for (const pi of instances) {
    const src = parseRef(pi.props.m_SourcePrefab);
    const parentTf = instanceParent(pi);
    const ipath = instancePath(pi, 0);
    fileBody.push(ipath);
    const parentGo = parentTf ? goOf(parentTf) : undefined;
    const owner = parentGo ? (goFirstNode.get(parentGo) ?? rel) : rel;
    if (src?.guid && !(variantBase && src.guid === variantBase && !parentTf)) {
      intent(o, rel, "nests", { k: "prefab", guid: src.guid, via: ipath });
      if (owner !== rel) intent(o, owner, "nests", { k: "prefab", guid: src.guid, via: ipath });
    }
    for (const it of itemsOf(pi, "m_Modifications")) {
      const ref = parseRef(it.v.objectReference);
      if (!ref || (ref.fid === "0" && !ref.guid)) continue;
      const via = `${ipath}.${it.v.propertyPath ?? "?"}`;
      if (ref.guid) intent(o, rel, "assigns", { k: "asset", guid: ref.guid, fid: ref.fid, via });
      else {
        const t = nodeFor(ref.fid);
        if (t) o.edges.push({ source: rel, relation: "assigns", file: rel, targetId: t, unity: { k: "asset", guid: "", via } });
      }
    }
  }
  if (variantBase) intent(o, rel, "variant_of", { k: "variant", guid: variantBase });

  const sig =
    kind === "scene"
      ? `Scene ${basename(rel, ".unity")} (${gos.length} GameObjects, ${instances.length} prefab instances)`
      : variantBase
        ? `Prefab variant ${basename(rel, ".prefab")}`
        : `Prefab ${basename(rel, ".prefab")}`;
  o.nodes.unshift(fileNode(rel, source, sig, `${sig} ${fileBody.join(" ")}`));
  const asset: NonNullable<UnityFacts["asset"]> = { kind };
  if (kind === "prefab") {
    asset.objects = objects;
    if (prefabRoot && goFirstNode.has(prefabRoot.fileId)) asset.root = goFirstNode.get(prefabRoot.fileId);
  }
  if (animators.length) asset.animators = animators;
  if (playerInputs.length) asset.playerInputs = playerInputs;
  return { asset };
}

// ── generic YAML assets (ScriptableObjects, materials, clips, settings) ──────

function extractYamlAsset(rel: string, source: string, o: Out, kind: string): UnityFacts {
  const docs = scanUnityYaml(source);
  const main = docs[0];
  const name = main?.name ?? basename(rel, extname(rel));
  const asset: NonNullable<UnityFacts["asset"]> = { kind };
  const bodyParts: string[] = [name];
  let sig = `${main?.type ?? "Asset"} "${name}"`;
  const base = basename(rel);

  if (rel === "ProjectSettings/TagManager.asset" && main) {
    const layerItems = itemsOf(main, "layers");
    const tagItems = itemsOf(main, "tags").filter((i) => i.v[""]);
    const layers = layerItems.map((i) => i.v[""] ?? "");
    const tags = tagItems.map((i) => i.v[""]);
    asset.layers = layers;
    asset.tags = tags;
    o.nodes.push(fileNode(rel, source, "TagManager (tags, layers)", `tags ${[...BUILTIN_TAGS, ...tags].join(" ")} layers ${layers.join(" ")}`));
    // built-in tags are not in the file; user tags and layers sit on their own line
    for (const t of BUILTIN_TAGS) addNode(o, `tag:${t}`, t, "tag", main.start, main.end, `tag "${t}" (built-in)`, `tag ${t}`);
    for (const i of tagItems) addNode(o, `tag:${i.v[""]}`, i.v[""], "tag", i.line, i.line, `tag "${i.v[""]}"`, `tag ${i.v[""]}`);
    layerItems.forEach((it, i) => {
      const l = it.v[""];
      if (l) addNode(o, `layer:${l}`, l, "layer", it.line, it.line, `layer ${i} "${l}"`, `layer ${l} ${i}`);
    });
    return { asset };
  }
  if (rel === "ProjectSettings/EditorBuildSettings.asset" && main) {
    const scenes = itemsOf(main, "m_Scenes").map((i) => ({ path: i.v.path ?? "", guid: i.v.guid?.toLowerCase(), enabled: i.v.enabled === "1" }));
    asset.scenes = scenes;
    // config objects (`com.unity.input.settings.actions` → the project-wide input actions, …)
    const configs = [...new Set(main.refs.filter((r) => r.path.startsWith("m_configObjects.")).map((r) => r.path.slice("m_configObjects.".length)))];
    const sig = `EditorBuildSettings (scenes in build: ${scenes.filter((s) => s.enabled).map((s) => s.path).join(", ")}${configs.length ? `; config objects: ${configs.join(", ")}` : ""})`;
    o.nodes.push(fileNode(rel, source, sig, `${sig} build scenes ${scenes.map((s) => s.path).join(" ")}`));
    let index = 0;
    for (const s of scenes) {
      const via = s.enabled ? `build index ${index++}` : "in build list, disabled";
      intent(o, rel, "references", { k: "scene", guid: s.guid, path: s.path, via });
    }
    for (const r of main.refs) if (r.guid) intent(o, rel, "assigns", { k: "asset", guid: r.guid, fid: r.fid, via: r.path });
    return { asset };
  }

  for (const d of docs) {
    // Addressables groups: each entry gives an asset an address code loads it by
    const entries = itemsOf(d, "m_SerializeEntries").filter((i) => i.v.m_GUID && i.v.m_Address);
    if (entries.length) {
      asset.addresses = [...(asset.addresses ?? []), ...entries.map((i) => ({ address: i.v.m_Address, guid: i.v.m_GUID.toLowerCase() }))];
      bodyParts.push(...entries.map((i) => i.v.m_Address));
    }
    // AudioMixer: exposed parameters are what `mixer.SetFloat("Name", v)` drives
    if (d.classId === 241) {
      for (const p of itemsOf(d, "m_ExposedParameters")) {
        const pn = p.v.name;
        if (pn) addNode(o, `Exposed/${pn}`, pn, "parameter", p.line, p.line + 1, `exposed AudioMixer parameter "${pn}" of ${d.name ?? basename(rel)}`, `${pn} audio mixer exposed parameter`);
      }
      sig = `AudioMixer "${d.name ?? basename(rel)}"`;
    }
    if (d !== main && d.name) bodyParts.push(d.name); // sub-objects: renderer features, volume overrides, timeline tracks
    layerMaskRefs(d, rel, o);
    if (d === main && d.classId === MONOBEHAVIOUR) {
      const script = parseRef(d.props.m_Script);
      const cls = classIdentifier(d);
      if (script?.guid || cls) intent(o, rel, "instance_of", { k: "so", guid: script?.guid ?? "", fid: script?.fid, ...(cls ? { cls } : {}) });
      sig = `ScriptableObject asset "${name}"${cls ? ` (${cls})` : ""}`;
      for (const [k, v] of Object.entries(d.props)) if (!STD_KEYS.has(k) && !v.startsWith("{fileID")) bodyParts.push(`${k}=${v}`);
    } else if (d.classId === MONOBEHAVIOUR) {
      // sub-asset objects (timeline tracks, volume components, …)
      const script = parseRef(d.props.m_Script);
      if (script?.guid) intent(o, rel, "references", { k: "script", guid: script.guid, fid: script.fid, ...(classIdentifier(d) ? { cls: classIdentifier(d) } : {}) });
    }
    if (d.classId === 21) {
      // Material
      const shader = parseRef(d.props.m_Shader);
      if (shader && (shader.guid || shader.fid !== "0")) intent(o, rel, "uses_shader", { k: "shader", guid: shader.guid, fid: shader.fid });
      sig = `Material "${name}"`;
      const props = itemsOf(d, "m_Floats").concat(itemsOf(d, "m_Colors"), itemsOf(d, "m_Ints")).flatMap((i) => Object.keys(i.v).filter((k) => !k.includes(".")));
      const texs = [...new Set(d.refs.filter((r) => /m_TexEnvs/.test(r.path)).map((r) => r.path.split(".").at(-2) ?? ""))];
      bodyParts.push(...props, ...texs, d.props.m_ValidKeywords ?? "", ...itemsOf(d, "m_ValidKeywords").map((i) => i.v[""] ?? ""));
    }
    if (d.classId === 74) {
      // AnimationClip: events call methods on the animated GameObject's scripts
      sig = `AnimationClip "${name}"`;
      for (const ev of itemsOf(d, "m_Events")) {
        const fn = ev.v.functionName;
        if (fn) {
          intent(o, rel, "invokes", { k: "animevent", fn });
          bodyParts.push(`event ${fn}`);
        }
      }
    }
    if (d.classId === 221) sig = `AnimatorOverrideController "${name}"`;
    for (const r of d.refs) {
      if (r.path.startsWith("m_Script") || r.path === "m_Shader") continue;
      if (r.guid) {
        if (r.guid === "0000000000000000e000000000000000" || r.guid === "0000000000000000f000000000000000") continue;
        const via = d.classId === 21 && /m_TexEnvs/.test(r.path) ? (r.path.split(".").at(-2) ?? r.path) : r.path;
        intent(o, rel, "assigns", { k: "asset", guid: r.guid, fid: r.fid, via });
      }
    }
  }
  o.nodes.unshift(fileNode(rel, source, sig, `${sig} ${bodyParts.join(" ")} ${base}`));
  return { asset };
}

/** `m_LayerMask: { serializedVersion: 2, m_Bits: 512 }` and the like: a serialized
 * LayerMask names layers by bit. Each set bit references that layer. */
function layerMaskRefs(d: UDoc, source: string, o: Out): void {
  for (const m of d.masks ?? []) emitBits(m.bits, `${d.name ? `${d.name}.` : ""}${m.path}`, source, o);
}

function emitBits(bits: number, via: string, source: string, o: Out): void {
  if (!bits || bits === 0xffffffff || bits < 0) return;
  for (let i = 0; i < 32; i++) if (bits & (1 << i)) intent(o, source, "references", { k: "layer", index: i, via } as UnityIntent);
}

// ── Animator controllers ────────────────────────────────────────────────────

const PARAM_TYPES: Record<string, string> = { "1": "Float", "3": "Int", "4": "Bool", "9": "Trigger" };

function extractController(rel: string, source: string, o: Out): UnityFacts {
  const docs = scanUnityYaml(source);
  const byId = new Map(docs.map((d) => [d.fileId, d]));
  const ctrl = docs.find((d) => d.classId === 91);
  const name = ctrl?.name ?? basename(rel, ".controller");
  const params = ctrl ? itemsOf(ctrl, "m_AnimatorParameters").map((i) => ({ name: i.v.m_Name ?? "", type: PARAM_TYPES[i.v.m_Type ?? ""] ?? i.v.m_Type ?? "?", line: i.line })) : [];
  const layers = ctrl ? itemsOf(ctrl, "m_AnimatorLayers").map((i) => ({ name: i.v.m_Name ?? "", sm: parseRef(i.v.m_StateMachine)?.fid })) : [];
  const motions: GuidRef[] = [];
  const stateNames: string[] = [];
  const fileId = rel;
  o.nodes.push(fileNode(rel, source, `AnimatorController "${name}"`, ""));
  const paramNode = new Map<string, string>();
  for (const p of params) {
    if (!p.name) continue;
    const id = addNode(o, `Parameters/${p.name}`, p.name, "parameter", p.line, p.line + 3, `${p.type} parameter "${p.name}" of ${name}`, `${p.name} ${p.type} animator parameter ${name}`);
    paramNode.set(p.name, id);
  }
  // states, by walking each layer's state machine (and sub-machines)
  const stateNode = new Map<string, string>();
  const visitMachine = (fid: string | undefined, prefix: string, depth: number) => {
    const sm = fid ? byId.get(fid) : undefined;
    if (!sm || depth > 16) return;
    for (const cs of itemsOf(sm, "m_ChildStates")) {
      const sfid = parseRef(cs.v.m_State)?.fid;
      const st = sfid ? byId.get(sfid) : undefined;
      if (!st || stateNode.has(st.fileId)) continue;
      const sname = st.name ?? "(state)";
      const motion = parseRef(st.props.m_Motion);
      const transitions = itemsOf(st, "m_Transitions").map((t) => parseRef(t.v[""])?.fid).filter((x): x is string => !!x);
      const conds: string[] = [];
      for (const tf of transitions) {
        const tr = byId.get(tf);
        if (!tr) continue;
        const dst = byId.get(parseRef(tr.props.m_DstState)?.fid ?? "");
        const cs2 = itemsOf(tr, "m_Conditions").map((c) => c.v.m_ConditionEvent).filter(Boolean);
        conds.push(`→ ${dst?.name ?? "?"}${cs2.length ? ` when ${cs2.join(" & ")}` : ""}`);
      }
      const id = addNode(
        o,
        `${prefix}/${sname}`,
        sname,
        "state",
        st.start,
        st.end,
        `state "${prefix}/${sname}" of ${name}${motion?.guid ? "" : ""}`,
        `${sname} ${prefix} state ${name} ${conds.join(" ")} ${st.props.m_Tag ?? ""}`,
      );
      stateNode.set(st.fileId, id);
      stateNames.push(sname);
      if (motion?.guid) {
        motions.push({ guid: motion.guid, fid: motion.fid });
        intent(o, id, "assigns", { k: "asset", guid: motion.guid, fid: motion.fid, via: "m_Motion" });
      } else if (motion && motion.fid !== "0") {
        // blend tree inside the controller
        const bt = byId.get(motion.fid);
        for (const r of bt?.refs ?? []) if (r.guid) {
          motions.push({ guid: r.guid, fid: r.fid });
          intent(o, id, "assigns", { k: "asset", guid: r.guid, fid: r.fid, via: `BlendTree ${bt?.name ?? ""}`.trim() });
        }
      }
      for (const b of itemsOf(st, "m_StateMachineBehaviours")) {
        const smb = byId.get(parseRef(b.v[""])?.fid ?? "");
        const script = parseRef(smb?.props.m_Script);
        if (script?.guid) intent(o, id, "attaches", { k: "script", guid: script.guid, fid: script.fid, ...(smb && classIdentifier(smb) ? { cls: classIdentifier(smb) } : {}) });
      }
    }
    for (const sub of itemsOf(sm, "m_ChildStateMachines")) {
      const subFid = parseRef(sub.v.m_StateMachine)?.fid;
      const subDoc = subFid ? byId.get(subFid) : undefined;
      visitMachine(subFid, `${prefix}/${subDoc?.name ?? "?"}`, depth + 1);
    }
  };
  for (const l of layers) visitMachine(l.sm, l.name, 0);
  // transition conditions reference parameters
  for (const d of docs) {
    if (d.classId !== 1101 && d.classId !== 1109) continue;
    const owner = docs.find((s) => s.classId === 1102 && itemsOf(s, "m_Transitions").some((t) => parseRef(t.v[""])?.fid === d.fileId));
    const src = owner ? stateNode.get(owner.fileId) : undefined;
    for (const c of itemsOf(d, "m_Conditions")) {
      const p = c.v.m_ConditionEvent ? paramNode.get(c.v.m_ConditionEvent) : undefined;
      if (p) local(o, src ?? fileId, "references", p);
    }
  }
  const fnode = o.nodes[0];
  // States and parameters in the signature: it is what `ask` shows next to the path.
  const list = (xs: string[], max: number) => (xs.join(", ").length > max ? `${xs.join(", ").slice(0, max)}…` : xs.join(", "));
  fnode.signature = `AnimatorController "${name}" states: ${list(stateNames, 300)}; parameters: ${list(params.map((p) => `${p.name} (${p.type})`), 200)}`;
  fnode.body_text = body(`${fnode.signature} states ${stateNames.join(" ")} parameters ${params.map((p) => `${p.name}:${p.type}`).join(" ")} layers ${layers.map((l) => l.name).join(" ")}`, 16000);
  return { asset: { kind: "controller", motions } };
}

// ── Input System ────────────────────────────────────────────────────────────

interface IaJson {
  name?: string;
  maps?: Array<{
    name: string;
    actions?: Array<{ name: string; type?: string; expectedControlType?: string }>;
    bindings?: Array<{ name?: string; path?: string; action?: string; groups?: string; isComposite?: boolean; isPartOfComposite?: boolean }>;
  }>;
  controlSchemes?: Array<{ name: string }>;
}

function extractInputActions(rel: string, source: string, o: Out): UnityFacts {
  let json: IaJson;
  try {
    json = JSON.parse(source) as IaJson;
  } catch {
    o.nodes.push(fileNode(rel, source, "InputActionAsset (unparseable)", ""));
    return { asset: { kind: "inputactions" } };
  }
  const lines = source.split("\n");
  const lineOf = (needle: string, from = 0): number => {
    for (let i = from; i < lines.length; i++) if (lines[i].includes(needle)) return i;
    return from;
  };
  const maps: Array<{ name: string; actions: string[] }> = [];
  // The whole asset at a glance: maps, actions and their bindings.
  const overview = (json.maps ?? [])
    .map((m) => `${m.name}: ${(m.actions ?? []).map((a) => `${a.name} [${(m.bindings ?? []).filter((b) => b.action === a.name && b.path).map((b) => b.path).join(", ")}]`).join("; ")}`)
    .join(" | ");
  const sig = `InputActionAsset "${json.name ?? basename(rel, ".inputactions")}" — ${overview.length > 1200 ? `${overview.slice(0, 1200)}…` : overview}`;
  o.nodes.push(fileNode(rel, source, sig, `${sig} ${(json.controlSchemes ?? []).map((c) => c.name).join(" ")}`));
  let cursor = 0;
  for (const m of json.maps ?? []) {
    const actions: string[] = [];
    cursor = lineOf(`"name": "${m.name}"`, cursor);
    for (const a of m.actions ?? []) {
      const bindings = (m.bindings ?? []).filter((b) => b.action === a.name).map((b) => (b.isComposite ? `${b.name ?? "composite"}(${b.path})` : b.path)).filter(Boolean) as string[];
      const line = lineOf(`"name": "${a.name}"`, cursor);
      addNode(
        o,
        `${m.name}/${a.name}`,
        a.name,
        "action",
        line,
        line + 8,
        `${m.name}/${a.name} (${a.type ?? "?"}${a.expectedControlType ? ` ${a.expectedControlType}` : ""}) | ${bindings.join(", ")}`,
        `${a.name} ${m.name} input action ${a.type ?? ""} ${bindings.join(" ")}`,
      );
      actions.push(a.name);
    }
    maps.push({ name: m.name, actions });
  }
  return { asset: { kind: "inputactions", maps } };
}

// ── Assembly definitions ────────────────────────────────────────────────────

function extractAsmdef(rel: string, source: string, o: Out, kind: string): UnityFacts {
  let json: { name?: string; reference?: string; references?: string[]; rootNamespace?: string; includePlatforms?: string[]; defineConstraints?: string[]; optionalUnityReferences?: string[]; precompiledReferences?: string[] };
  try {
    json = JSON.parse(source);
  } catch {
    o.nodes.push(fileNode(rel, source, `${kind} (unparseable)`, ""));
    return { asset: { kind } };
  }
  if (kind === "asmref") {
    o.nodes.push(fileNode(rel, source, `Assembly reference → ${json.reference ?? "?"}`, `asmref ${json.reference ?? ""}`));
    if (json.reference) intent(o, rel, "references", { k: "asmref", ref: json.reference, rel: "compiles" });
    return { asset: { kind } };
  }
  const name = json.name ?? basename(rel, ".asmdef");
  const editor = !!json.includePlatforms?.length && json.includePlatforms.every((p) => p === "Editor");
  const test = !!(json.defineConstraints?.includes("UNITY_INCLUDE_TESTS") || json.optionalUnityReferences?.includes("TestAssemblies") || json.precompiledReferences?.includes("nunit.framework.dll"));
  const conds = [...(json.defineConstraints ?? []), ...((json as { versionDefines?: Array<{ name?: string; define?: string }> }).versionDefines ?? []).map((v) => `${v.define} (when ${v.name})`)];
  const sig = `assembly ${name}${editor ? " (Editor)" : ""}${test ? " (tests)" : ""}${json.rootNamespace ? ` namespace ${json.rootNamespace}` : ""}${conds.length ? ` · compiled only with ${conds.join(", ")}` : ""}`;
  o.nodes.push(fileNode(rel, source, sig, `${sig} references ${(json.references ?? []).join(" ")}`));
  const id = addNode(o, name, name, "module", 0, source.split("\n").length - 1, sig, `${sig} ${(json.references ?? []).join(" ")}`);
  for (const r of json.references ?? []) intent(o, id, "imports", { k: "asmref", ref: r, rel: "imports" });
  const asm: { name: string; rootNs?: string; editor?: boolean; test?: boolean } = { name };
  if (json.rootNamespace) asm.rootNs = json.rootNamespace;
  if (editor) asm.editor = true;
  if (test) asm.test = true;
  return { asset: { kind, asm } };
}

// ── Shaders ─────────────────────────────────────────────────────────────────

function extractShader(rel: string, source: string, o: Out): UnityFacts {
  const ext = extname(rel).toLowerCase();
  const name = ext === ".shader" ? /^\s*Shader\s+"([^"]+)"/m.exec(source)?.[1] : undefined;
  const lines = source.split("\n");
  const sig = name ? `Shader "${name}"` : `${ext.slice(1).toUpperCase()} include ${basename(rel)}`;
  const passes = [...source.matchAll(/^\s*Name\s+"([^"]+)"/gm)].map((m) => m[1]);
  o.nodes.push(fileNode(rel, source, sig, `${sig} passes ${passes.join(" ")} ${source}`));
  // Properties block
  if (ext === ".shader") {
    const props = /\bProperties\s*\{/.exec(source);
    if (props) {
      let depth = 0;
      let i = props.index + props[0].length - 1;
      const start = i;
      for (; i < source.length; i++) {
        if (source[i] === "{") depth++;
        else if (source[i] === "}" && --depth === 0) break;
      }
      const block = source.slice(start, i);
      const baseLine = source.slice(0, start).split("\n").length - 1;
      const blines = block.split("\n");
      blines.forEach((l, k) => {
        const m = /^\s*(?:\[[^\]]*\]\s*)*(_?[A-Za-z_][A-Za-z0-9_]*)\s*\(\s*"([^"]*)"\s*,\s*([^)]*\)?[^)]*)\)/.exec(l);
        if (m) addNode(o, `Properties/${m[1]}`, m[1], "property", baseLine + k, baseLine + k, `${name ?? basename(rel)} property ${l.trim()}`, `${m[1]} ${m[2]} ${m[3]} shader property ${name ?? ""}`);
      });
    }
  }
  // includes
  for (const m of source.matchAll(/^\s*#\s*include(?:_with_pragmas)?\s+"([^"]+)"/gm)) intent(o, rel, "imports", { k: "include", path: m[1] });
  // UsePass "Shader/PASS", Fallback "Name"
  for (const m of source.matchAll(/^\s*UsePass\s+"([^"]+)\/[^"/]+"/gm)) intent(o, rel, "references", { k: "shader", name: m[1], via: "UsePass" });
  for (const m of source.matchAll(/^\s*Fallback\s+"([^"]+)"/gim)) if (m[1] !== "Off") intent(o, rel, "references", { k: "shader", name: m[1], via: "Fallback" });
  // HLSL functions (definitions with a body) — enough to navigate, not to call-graph
  const fnRe = /^[ \t]*(?:inline\s+|static\s+)*(?:[A-Za-z_][\w]*(?:<[^>]*>)?)\s+([A-Za-z_]\w*)\s*\(([^;{}]*)\)\s*(?::\s*\w+\s*)?$/;
  for (let i = 0; i < lines.length; i++) {
    const m = fnRe.exec(lines[i]);
    if (!m || /^(if|for|while|switch|return|else)$/.test(m[1])) continue;
    let j = i;
    while (j < lines.length && !lines[j].includes("{") && j - i < 3) j++;
    if (j >= lines.length || !lines[j].includes("{")) continue;
    let depth = 0;
    let k = j;
    for (; k < lines.length; k++) {
      for (const ch of lines[k]) {
        if (ch === "{") depth++;
        else if (ch === "}") depth--;
      }
      if (depth <= 0 && k >= j) break;
    }
    const text = lines.slice(i, k + 1).join("\n");
    addNode(o, m[1], m[1], "function", i, k, lines[i].trim(), text);
    i = k;
  }
  return { asset: name ? { kind: "shader", shaderName: name } : { kind: "shader" } };
}

function extractShaderGraph(rel: string, source: string, o: Out): UnityFacts {
  // Shader Graph 10+ writes several JSON objects back to back; older ones one.
  const objs: Array<Record<string, unknown>> = [];
  for (const chunk of source.split(/\n\s*\n(?=\{)/)) {
    try {
      objs.push(JSON.parse(chunk) as Record<string, unknown>);
    } catch {
      /* skip */
    }
  }
  const graph = objs.find((x) => typeof x.m_Type === "string" && /GraphData$/.test(x.m_Type as string)) ?? objs[0];
  const sub = rel.toLowerCase().endsWith(".shadersubgraph");
  const graphPath = typeof graph?.m_Path === "string" ? (graph.m_Path as string) : "Shader Graphs";
  const shaderName = sub ? undefined : `${graphPath}/${basename(rel, extname(rel))}`;
  const sig = sub ? `Shader Sub Graph ${basename(rel, extname(rel))}` : `Shader Graph "${shaderName}"`;
  o.nodes.push(fileNode(rel, source, sig, sig));
  const propNames: string[] = [];
  for (const x of objs) {
    const t = typeof x.m_Type === "string" ? (x.m_Type as string) : "";
    if (/ShaderProperty$|ShaderKeyword$/.test(t)) {
      const ref = (x.m_OverrideReferenceName as string) || (x.m_DefaultReferenceName as string) || "";
      const display = (x.m_Name as string) ?? ref;
      if (!ref) continue;
      propNames.push(ref);
      const line = source.slice(0, source.indexOf(`"${ref}"`)).split("\n").length - 1;
      addNode(o, `Properties/${ref}`, ref, "property", Math.max(0, line), Math.max(0, line), `${sig} property ${ref} ("${display}") ${t.split(".").pop()}`, `${ref} ${display} shader graph property`);
    }
    if (/SubGraphNode$/.test(t)) {
      const ser = x.m_SerializedSubGraph;
      const g = typeof ser === "string" ? /"guid"\s*:\s*"([0-9a-f]{32})"/.exec(ser)?.[1] : undefined;
      if (g) intent(o, rel, "nests", { k: "prefab", guid: g, via: "Sub Graph" });
    }
  }
  o.nodes[0].body_text = body(`${sig} ${propNames.join(" ")}`, 16000);
  return { asset: { kind: "shadergraph", ...(shaderName ? { shaderName } : {}) } };
}

// ── UI Toolkit ──────────────────────────────────────────────────────────────

function extractUi(rel: string, source: string, o: Out, kind: string): UnityFacts {
  if (kind === "uxml") {
    const names = [...source.matchAll(/\bname="([^"]+)"/g)].map((m) => m[1]);
    const sig = `UXML ${basename(rel)}`;
    o.nodes.push(fileNode(rel, source, sig, `${sig} ${names.join(" ")} ${source}`));
    for (const m of source.matchAll(/<(?:\w+:)?(?:Style|Template)\b[^>]*\bsrc="([^"]+)"/g)) intent(o, rel, "imports", { k: "include", path: m[1] });
  } else {
    const selectors = [...source.matchAll(/^([^{@/][^{]*)\{/gm)].map((m) => m[1].trim());
    const sig = `USS ${basename(rel)}`;
    o.nodes.push(fileNode(rel, source, sig, `${sig} ${selectors.join(" ")}`));
    for (const m of source.matchAll(/@import\s+(?:url\()?["']([^"']+)["']/g)) intent(o, rel, "imports", { k: "include", path: m[1] });
  }
  return { asset: { kind } };
}

/** Resolve an include/import path written in `file` to a repo-relative path candidate. */
export function includeCandidates(file: string, spec: string): string[] {
  const clean = spec.replace(/^project:\/\/database\//, "").replace(/\?.*$/, "");
  if (/^(Assets|Packages)\//.test(clean)) return [clean];
  const dir = dirname(file);
  return [posix.normalize(posix.join(dir, clean))];
}
