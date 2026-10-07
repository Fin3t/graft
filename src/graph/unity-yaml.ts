/**
 * UnityYAML scanner — one pass over the lines of a text-serialized Unity file
 * (scene, prefab, asset, material, controller, clip, `.meta`), no YAML parser.
 *
 * Unity writes "a custom subset of YAML" (Manual 6000.6, Format of Text
 * Serialized files): every object is a document headed `--- !u!<classID>
 * &<fileID>` (plus ` stripped` for an object that stands in for one inside a
 * nested prefab), keys are 2-space indented, sequences put `- ` at or one level
 * below their key, and every object reference is the flow mapping
 * `{fileID: N, guid: G, type: T}` (guid/type only when it points into another
 * file). That regularity is what makes a line scanner sufficient — and a 6 MB
 * scene scans in tens of milliseconds without building a tree.
 *
 * What it keeps per document is deliberately small: identity, `m_Name`, the
 * hierarchy keys, every reference with the property path it sits under, and the
 * items of a fixed allow-list of sequences the extractors need (prefab
 * modifications, UnityEvent persistent calls, animator parameters/states,
 * animation events, build scenes, tags/layers, …). Everything else is skipped.
 */

export interface URef {
  /** Property path of the key holding the reference, list items elided:
   * `m_SavedProperties.m_TexEnvs._BaseMap.m_Texture`, `walkerPrefab`. */
  path: string;
  fid: string;
  guid?: string;
  type?: number;
  /** Id of the innermost sequence item the reference sits in (0 = none). */
  item: number;
  line: number; // 0-based
}

export interface UItem {
  /** Sequence path (`m_Modification.m_Modifications`). */
  list: string;
  id: number;
  /** Scalar values inside the item, keyed by path relative to the item. A bare
   * scalar item (`- Default`) is stored under "". */
  v: Record<string, string>;
  line: number;
}

export interface UDoc {
  classId: number;
  fileId: string;
  stripped: boolean;
  type: string;
  start: number; // 0-based line of the `---` header
  end: number; // 0-based last line
  name?: string;
  /** Top-level scalar properties (`m_TagString`, `m_Layer`, `m_IsActive`, …). */
  props: Record<string, string>;
  refs: URef[];
  items: UItem[];
}

/** Sequences whose items extractors read. Matched on the LAST path segment. */
const ITEM_LISTS = new Set([
  "m_Modifications", "m_Calls", "m_Events", "events", "m_AnimatorParameters", "m_AnimatorLayers",
  "m_ChildStates", "m_ChildStateMachines", "m_Conditions", "m_Scenes", "tags", "layers", "m_Component",
  "m_StateMachineBehaviours", "m_Transitions", "m_AnyStateTransitions", "m_EntryTransitions", "m_Clips",
  "m_ActionEvents", "clipAnimations", "externalObjects", "m_Floats", "m_Colors", "m_Ints",
  "m_AddedComponents", "m_AddedGameObjects", "m_RemovedComponents", "m_RemovedGameObjects",
  "m_ValidKeywords", "m_InvalidKeywords", "m_ShaderKeywords", "RefIds", "m_Materials",
]);

/** Keys whose (often numerous) references are hierarchy plumbing, read via props. */
const HIERARCHY_KEYS = new Set([
  "m_GameObject", "m_Father", "m_Children", "m_PrefabInstance", "m_PrefabAsset", "m_CorrespondingSourceObject",
  "m_PrefabParentObject", "m_PrefabInternal", "m_Script", "m_SourcePrefab", "m_TransformParent",
]);

const HEADER = /^--- !u!(-?\d+) &(-?\d+)( stripped)?/;
const REF = /\{fileID: (-?\d+)(?:, guid: ([0-9a-fA-F]{32}))?(?:, type: (-?\d+))?\}/g;

/**
 * Scan a UnityYAML text. `want` limits which documents are kept by class id
 * (`null` keeps all); skipped documents cost one header match each.
 */
export function scanUnityYaml(text: string, want: ReadonlySet<number> | null = null): UDoc[] {
  const docs: UDoc[] = [];
  let doc: UDoc | null = null;
  let keep = false;
  // key stack: indentation + key
  const stackIndent: number[] = [];
  const stackKey: string[] = [];
  // open sequences: indentation of their dash, their path, current item id
  const seqIndent: number[] = [];
  const seqPath: string[] = [];
  const seqItem: number[] = [];
  const seqTracked: boolean[] = [];
  let itemCounter = 0;
  let curItem: UItem | null = null;
  let curItemDepth = 0; // key-stack depth at which the current item's keys start

  const finish = (lineNo: number) => {
    if (doc && keep) {
      doc.end = lineNo;
      docs.push(doc);
    }
  };

  let lineNo = 0;
  let pos = 0;
  const len = text.length;
  while (pos <= len) {
    let nl = text.indexOf("\n", pos);
    if (nl === -1) nl = len;
    let line = text.slice(pos, nl);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    pos = nl + 1;
    const ln = lineNo++;
    if (line.startsWith("---")) {
      const m = HEADER.exec(line);
      finish(ln - 1);
      stackIndent.length = 0;
      stackKey.length = 0;
      seqIndent.length = 0;
      seqPath.length = 0;
      seqItem.length = 0;
      seqTracked.length = 0;
      curItem = null;
      if (m) {
        const classId = Number(m[1]);
        keep = want === null || want.has(classId);
        doc = { classId, fileId: m[2], stripped: !!m[3], type: "", start: ln, end: ln, props: {}, refs: [], items: [] };
      } else {
        doc = null;
        keep = false;
      }
      continue;
    }
    if (!doc || !keep) {
      if (!doc && line.length && !line.startsWith("%")) {
        // A file without headers (a `.meta`, a JSON-less YAML) is one implicit document.
        doc = { classId: -1, fileId: "0", stripped: false, type: "", start: ln, end: ln, props: {}, refs: [], items: [] };
        keep = true;
      } else continue;
    }
    if (!line.trim() || line.startsWith("%")) continue;

    // indentation and list dash
    let indent = 0;
    while (indent < line.length && line.charCodeAt(indent) === 32) indent++;
    let rest = line.slice(indent);
    let isItem = false;
    if (rest.startsWith("- ") || rest === "-") {
      isItem = true;
      rest = rest.slice(2);
    }
    const eff = isItem ? indent + 2 : indent;

    if (isItem) {
      // close deeper keys; the sequence belongs to the nearest key at indent <= dash indent
      while (stackIndent.length && stackIndent[stackIndent.length - 1] > indent) {
        stackIndent.pop();
        stackKey.pop();
      }
      while (seqIndent.length && seqIndent[seqIndent.length - 1] > indent) {
        seqIndent.pop();
        seqPath.pop();
        seqItem.pop();
        seqTracked.pop();
      }
      const path = stackKey.join(".");
      const top = seqIndent.length - 1;
      if (top >= 0 && seqIndent[top] === indent && seqPath[top] === path) {
        seqItem[top] = ++itemCounter;
      } else {
        seqIndent.push(indent);
        seqPath.push(path);
        seqItem.push(++itemCounter);
        seqTracked.push(ITEM_LISTS.has(stackKey[stackKey.length - 1] ?? ""));
      }
      const t = seqIndent.length - 1;
      if (seqTracked[t]) {
        curItem = { list: path, id: seqItem[t], v: {}, line: ln };
        doc.items.push(curItem);
        curItemDepth = stackKey.length;
      } else if (curItem && stackKey.length <= curItemDepth) curItem = null;
    } else {
      while (stackIndent.length && stackIndent[stackIndent.length - 1] >= eff) {
        stackIndent.pop();
        stackKey.pop();
      }
      while (seqIndent.length && seqIndent[seqIndent.length - 1] >= eff) {
        seqIndent.pop();
        seqPath.pop();
        seqItem.pop();
        seqTracked.pop();
      }
      if (curItem && stackKey.length < curItemDepth) curItem = null;
    }

    // `key: value` or a bare scalar / flow item
    const colon = keyColon(rest);
    let key: string | null = null;
    let value: string;
    if (colon >= 0) {
      key = rest.slice(0, colon);
      value = rest.slice(colon + 1).trim();
    } else {
      value = rest.trim();
    }

    if (key !== null && value === "" && stackKey.length === 0 && !isItem && indent === 0 && !doc.type) {
      // the type line: `MonoBehaviour:` (a `.meta`'s importer: `MonoImporter:`)
      doc.type = key;
      continue;
    }
    const curItemIdx = seqItem.length ? seqItem[seqItem.length - 1] : 0;

    if (key !== null) {
      const parentPath = stackKey.join(".");
      const path = parentPath ? `${parentPath}.${key}` : key;
      if (stackKey.length === 0 && !isItem && value) {
        doc.props[key] = value;
        if (key === "m_Name") doc.name = value;
      }
      if (curItem) {
        const rel = path.split(".").slice(curItemDepth).join(".");
        if (value) curItem.v[rel] = value;
      }
      if (value.includes("{fileID:")) collectRefs(doc, path, value, curItemIdx, ln, key);
      if (!value || value === "|" || value === ">") {
        stackIndent.push(eff);
        stackKey.push(key);
      }
    } else if (value) {
      const path = stackKey.join(".");
      if (curItem) curItem.v[""] = value;
      if (value.includes("{fileID:")) collectRefs(doc, path, value, curItemIdx, ln, stackKey[stackKey.length - 1] ?? "");
    }
  }
  finish(lineNo - 1);
  return docs;
}

/** Index of the `:` that ends a mapping key, or -1. Keys never start with `{`/`[`
 * and the separator is `: ` or a trailing `:`. */
function keyColon(s: string): number {
  if (!s || s[0] === "{" || s[0] === "[" || s[0] === '"' || s[0] === "'") return -1;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 58 /* : */ && (i === s.length - 1 || s.charCodeAt(i + 1) === 32)) return i;
    if (c === 123 /* { */) return -1;
  }
  return -1;
}

function collectRefs(doc: UDoc, path: string, value: string, item: number, line: number, key: string): void {
  // Hierarchy plumbing is read from top-level props; m_TransformParent (nested
  // under m_Modification) stays a ref.
  if (HIERARCHY_KEYS.has(key) && key !== "m_TransformParent") return;
  REF.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = REF.exec(value))) {
    const fid = m[1];
    if (fid === "0" && !m[2]) continue;
    const ref: URef = { path, fid, item, line };
    if (m[2]) ref.guid = m[2].toLowerCase();
    if (m[3]) ref.type = Number(m[3]);
    doc.refs.push(ref);
  }
}

/** First `{fileID, guid, type}` in a flow value. */
export function parseRef(value: string | undefined): { fid: string; guid?: string; type?: number } | null {
  if (!value) return null;
  REF.lastIndex = 0;
  const m = REF.exec(value);
  if (!m) return null;
  const r: { fid: string; guid?: string; type?: number } = { fid: m[1] };
  if (m[2]) r.guid = m[2].toLowerCase();
  if (m[3]) r.type = Number(m[3]);
  return r;
}

/** Group a document's items by their list path suffix. */
export function itemsOf(doc: UDoc, listSuffix: string): UItem[] {
  return doc.items.filter((i) => i.list === listSuffix || i.list.endsWith(`.${listSuffix}`));
}
