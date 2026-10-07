/**
 * C# depth tier — scope-aware extraction for `.cs` files (Unity's language).
 *
 * The breadth tier (generic.ts + queries/c_sharp.scm) only ever saw bare names: a
 * call `walker.Tick()` named "Tick", and with 22 `Tick`s in a Unity project the
 * resolver rightly dropped it. Resolving it needs what C# itself needs: the
 * namespace and `using`s in force, the declared type of `walker` (a field, a
 * parameter, a `var` initialised from `GetComponent<Walker>()`, a `foreach`
 * variable over a `List<Walker>`), the members and base types of every type in
 * the repo — partial classes spread over several files included.
 *
 * Most of that is not file-local, so this module splits the work the way the
 * rest of graft does (pure per-file extraction, cached; global resolution, cheap):
 *
 *   - nodes: one per type and member (class/struct/interface/enum/record/
 *     delegate; method/ctor/operator/indexer/property/event/field/const; local
 *     functions), ids path-scoped like every other tier.
 *   - facts ({@link CsFacts}): what a resolver needs to know about the file's
 *     declarations — namespaces and `using` scopes, every type's bases, generic
 *     parameters and constraints, every member's declared type, parameters,
 *     modifiers, attributes and (for constants) string value.
 *   - intents: raw edges carrying a small expression IR ({@link Expr}) instead of
 *     a bare name. Locals are substituted while walking, so `var w =
 *     GetComponent<Walker>(); w.Tick()` reaches the resolver as
 *     `GetComponent<Walker>().Tick()` and needs no body-level state there.
 *
 * `csharp-resolve.ts` turns facts + intents into edges. Nothing here looks at
 * another file, so the extraction cache's cold == incremental contract holds.
 *
 * Grammar: tree-sitter-c-sharp from the `tree-sitter-wasm` bundle (ABI 15, parses
 * C# 9 — records, init accessors, target-typed `new`, patterns) via
 * `web-tree-sitter`, the runtime graft already ships for the breadth tier. Must be
 * warmed once ({@link warmCSharp}) before the synchronous {@link extractCSharp}.
 */
import { basename } from "node:path";
import { contentHash } from "../util/id.js";
import { loadWasmLanguage } from "./generic.js";
import type { ExtractResult, RawEdge } from "./extract.js";
import type { Kind, NodeV1, Relation } from "./types.js";

// ── IR ──────────────────────────────────────────────────────────────────────

/**
 * A C# expression, reduced to what typing a member access needs. Tuples, not
 * objects, because thousands of these sit in the extraction cache.
 *
 *   ["i", name]               bare identifier (field, property, type, namespace…)
 *   ["t"] / ["b"]             this / base
 *   ["m", recv, name]         member access `recv.name`
 *   ["c", fn, argc, targs?, a0?] invocation; fn is an "i" or "m" expr; targs =
 *                             explicit generic arguments (`GetComponent<Walker>()`);
 *                             a0 = the first argument, kept only for `Instantiate(x)`
 *                             whose result has the type of `x`
 *   ["n", type, argc]         `new T(…)`; type "?" = target-typed `new()`
 *   ["N", target, argc]       target-typed `new()` whose type is that of `target`
 *   ["x", recv]               element access `recv[…]`
 *   ["e", recv]               element of a collection (foreach / lambda parameter)
 *   ["dv", recv]              value type of a dictionary (`TryGetValue(k, out var v)`)
 *   ["T", type]               an expression whose static type is written out (cast,
 *                             `as`, a declared local, a literal)
 *   ["a", inner]              `await inner` (Task<T> → T)
 *   ["g", inner]              a method group (`AddListener(Play)`, `+= OnHit`)
 *   ["tu", recv, i]           element i of a tuple (`var (a, b) = Pair()`)
 */
export type Expr =
  | ["i", string]
  | ["t"]
  | ["b"]
  | ["m", Expr, string]
  | ["c", Expr, number, string[]?, Expr?]
  | ["n", string, number]
  | ["N", Expr, number]
  | ["x", Expr]
  | ["e", Expr]
  | ["dv", Expr]
  | ["T", string]
  | ["a", Expr]
  | ["g", Expr]
  | ["tu", Expr, number];

/** One piece of a string value: a literal, a reference to a constant/static field
 * whose value the resolver knows, or null for anything computed at run time. */
export type StrPart = string | ["r", Expr] | null;
/** A string value: concatenated parts. Alternatives (`c ? "a" : "b"`, array
 * elements) are separate StrVals. */
export type StrVal = StrPart[];

/** What the resolver should do with one raw edge from this tier. */
export interface CsIntent {
  /** Innermost enclosing type id (member lookup for bare names, `this`, `base`). */
  ty?: string;
  /** Index into {@link CsFacts.scopes}: the namespace + `using`s in force. */
  u: number;
  /** Expression whose resolution is the target (calls, references, handlers). */
  e?: Expr;
  /** Type text whose resolution is the target (heritage, type references). */
  t?: string;
  /** Already-known target (a local function). */
  to?: string;
  /** Edge display hint (`subscribes`: the event expression). */
  via?: string;
}

/** A string-named Unity reference found in code — `Resources.Load<T>("x")`,
 * `animator.SetTrigger(AttackHash)`, `SendMessage("Die")`, … The resolver decides
 * what the string names from `op` (the method), the receiver's type and `args`. */
export interface CsUnityIntent {
  op: string;
  ty?: string;
  u: number;
  recv?: Expr;
  /** Generic argument (`Resources.Load<Texture2D>`), or the type of `typeof(T)`. */
  targ?: string;
  /** Each string argument as its possible values. */
  args: StrVal[][];
}

/** A `using` scope: the compilation unit or one namespace body. */
export interface CsScope {
  ns: string; // fully-qualified namespace this scope declares ("" = global)
  usings: string[]; // `using A.B;`
  statics: string[]; // `using static A.B.C;`
  aliases: Array<[string, string]>; // `using X = A.B.C;`
  parent: number; // enclosing scope index, -1 for the compilation unit
}

export interface CsAttr {
  n: string; // attribute name as written (`MenuItem`, `UnityEngine.MenuItem`)
  a?: string[]; // literal string / `typeof(X)` → "typeof:X" arguments, in order
}

export interface CsTypeFact {
  id: string;
  name: string;
  arity: number; // generic arity — `List<T>` and `List` are different types
  kind: Kind;
  record?: true;
  ns: string; // namespace ("" global)
  outer?: string; // enclosing type id (nested types)
  u: number; // scope the declaration sits in
  partial?: true;
  static?: true;
  abstract?: true;
  bases: string[]; // base_list entries as written
  tparams?: string[];
  constraints?: Record<string, string[]>; // `where T : Component`
  attrs?: CsAttr[];
  ret?: string; // delegates: the return type
}

export type CsMemberKind =
  | "method"
  | "ctor"
  | "cctor"
  | "dtor"
  | "op"
  | "prop"
  | "indexer"
  | "event"
  | "field"
  | "const"
  | "local"
  | "enum";

export interface CsParam {
  t: string; // type as written
  n: string;
  m?: string; // ref/out/in/this/params
  d?: 1; // has a default value (optional)
}

export interface CsMemberFact {
  id: string; // node id ("" for enum members, which get no node)
  owner: string; // declaring type id
  name: string;
  mk: CsMemberKind;
  type?: string; // return / declared type as written
  static?: true;
  params?: CsParam[];
  ext?: true; // extension method (`this` on its first parameter)
  tparams?: string[];
  constraints?: Record<string, string[]>;
  mod?: "virtual" | "override" | "abstract" | "new";
  iface?: string; // explicit interface implementation (`void IFoo.Bar()`)
  attrs?: CsAttr[];
  /** const / static readonly string(s), and `Animator.StringToHash("x")` /
   * `Shader.PropertyToID("_X")` initialisers ("hash:anim", "hash:prop"). */
  sv?: StrVal[];
  hash?: "anim" | "prop";
  serialized?: true; // public, or [SerializeField], or [SerializeReference] — and not static/const/readonly
}

export interface CsFacts {
  scopes: CsScope[];
  globalUsings?: string[];
  globalStatics?: string[];
  types: CsTypeFact[];
  members: CsMemberFact[];
}

// ── Grammar ─────────────────────────────────────────────────────────────────

type TsNode = {
  type: string;
  text: string;
  isNamed: boolean;
  startIndex: number;
  endIndex: number;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  childCount: number;
  namedChildCount: number;
  children: TsNode[];
  namedChildren: TsNode[];
  parent: TsNode | null;
  hasError: boolean;
  isMissing: boolean;
  child(i: number): TsNode | null;
  namedChild(i: number): TsNode | null;
  childForFieldName(name: string): TsNode | null;
};

let language: unknown | null = null;
let tsMod: typeof import("web-tree-sitter") | null = null;
let parser: InstanceType<typeof import("web-tree-sitter").Parser> | null = null;

/** Load the C# grammar once. Idempotent; false when the wasm is unavailable (the
 * build then falls back to the breadth tier for `.cs`). */
export async function warmCSharp(): Promise<boolean> {
  if (language) return true;
  language = await loadWasmLanguage("c_sharp");
  if (!language) return false;
  tsMod = await import("web-tree-sitter");
  parser = new tsMod.Parser();
  parser.setLanguage(language as never);
  return true;
}

export function isCSharpWarm(): boolean {
  return language !== null;
}

export function isCSharpPath(path: string): boolean {
  return path.toLowerCase().endsWith(".cs");
}

const PARSE_CHUNK = 16384;

function parse(source: string): { root: TsNode; done: () => void } {
  const tree = parser!.parse((i: number) => source.slice(i, i + PARSE_CHUNK))!;
  return { root: tree.rootNode as unknown as TsNode, done: () => tree.delete() };
}

// ── Preprocessor ────────────────────────────────────────────────────────────

/**
 * Symbols an `#if` is evaluated against when a file only parses with its inactive
 * branches removed. Editor code is part of what an agent edits, so `UNITY_EDITOR`
 * is on; `UNITY_*_OR_NEWER` is on (the project is Unity 6); platform symbols are
 * the macOS standalone player the project builds. Unknown symbols are off.
 */
const DEFINES: ReadonlyArray<RegExp> = [
  /^UNITY_EDITOR(_OSX|_64)?$/,
  /^UNITY_\d+(_\d+)*_OR_NEWER$/,
  /^UNITY_6000(_\d+)*$/,
  /^UNITY_STANDALONE(_OSX)?$/,
  /^ENABLE_INPUT_SYSTEM$/,
  /^ENABLE_MONO$/,
  /^NET_STANDARD(_2_1|_2_0)?$/,
  /^NETSTANDARD(2_1)?$/,
  /^CSHARP_7_3_OR_NEWER$/,
  /^UNITY_INCLUDE_TESTS$/,
  /^DEBUG$/,
  /^TRACE$/,
];

function defined(sym: string): boolean {
  return DEFINES.some((r) => r.test(sym));
}

/** Evaluate a `#if` condition: identifiers, `!`, `&&`, `||`, parentheses, true/false. */
export function evalCondition(cond: string): boolean {
  const toks = cond.match(/[A-Za-z_][A-Za-z0-9_]*|&&|\|\||==|!=|!|\(|\)/g) ?? [];
  let i = 0;
  const primary = (): boolean => {
    const t = toks[i++];
    if (t === "!") return !primary();
    if (t === "(") {
      const v = or();
      i++; // ")"
      return v;
    }
    if (t === "true") return true;
    if (t === "false" || t === undefined) return false;
    return defined(t);
  };
  const eq = (): boolean => {
    let v = primary();
    while (toks[i] === "==" || toks[i] === "!=") {
      const op = toks[i++];
      const r = primary();
      v = op === "==" ? v === r : v !== r;
    }
    return v;
  };
  const and = (): boolean => {
    let v = eq();
    while (toks[i] === "&&") {
      i++;
      const r = eq();
      v = v && r;
    }
    return v;
  };
  const or = (): boolean => {
    let v = and();
    while (toks[i] === "||") {
      i++;
      const r = and();
      v = v || r;
    }
    return v;
  };
  return or();
}

/**
 * Blank out the inactive branches of `#if/#elif/#else` (and the directive lines
 * themselves), keeping every offset and line number. tree-sitter-c-sharp parses
 * directives in place, which is right while a branch holds whole statements or
 * declarations — and wrong when `#if`/`#else` split an expression, where both
 * halves together are not C#. Only used for a file whose straight parse failed.
 */
export function blankInactiveBranches(source: string): string {
  const lines = source.split("\n");
  // Each frame: is the enclosing region active, has a branch been taken, is the current branch active.
  const stack: Array<{ outer: boolean; taken: boolean; on: boolean }> = [];
  const active = () => (stack.length === 0 ? true : stack[stack.length - 1].on);
  const blank = (s: string) => s.replace(/[^\r]/g, " ");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*#\s*(if|elif|else|endif)\b(.*)$/);
    if (m) {
      const [, d, rest] = m;
      const cond = rest.replace(/\/\/.*$/, "");
      if (d === "if") {
        const outer = active();
        const v = outer && evalCondition(cond);
        stack.push({ outer, taken: v, on: v });
      } else if (d === "elif") {
        const f = stack[stack.length - 1];
        if (f) {
          const v = f.outer && !f.taken && evalCondition(cond);
          f.on = v;
          f.taken = f.taken || v;
        }
      } else if (d === "else") {
        const f = stack[stack.length - 1];
        if (f) {
          f.on = f.outer && !f.taken;
          f.taken = true;
        }
      } else {
        stack.pop();
      }
      lines[i] = blank(lines[i]);
      continue;
    }
    if (!active()) lines[i] = blank(lines[i]);
  }
  return lines.join("\n");
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const MAX_BODY_CHARS = 5000;
const MAX_FILE_BODY_CHARS = 16000;

function searchBody(text: string, max = MAX_BODY_CHARS): string {
  const norm = text.replace(/\s+/g, " ").trim();
  return norm.length > max ? norm.slice(0, max) : norm;
}

function clean(raw: string): string | null {
  const sig = raw
    .replace(/\s+/g, " ")
    .trim()
    .replace(/(=>|[{:=;])\s*$/, "")
    .trim();
  return sig || null;
}

/** Normalised type text: whitespace removed, tuple element names dropped,
 * `global::` dropped. The resolver parses this back with its own small parser. */
export function typeText(n: TsNode | null | undefined): string | null {
  if (!n) return null;
  if (n.type === "implicit_type") return null;
  if (n.type === "tuple_type") return "(" + n.namedChildren.map((c) => typeText(c.childForFieldName("type")) ?? "?").join(",") + ")";
  return n.text.replace(/\s+/g, "").replace(/global::/g, "").replace(/(^|[^\w])@/g, "$1");
}

/** Predefined/primitive spellings, mapped to the CLR type the resolver keys on. */
export const PREDEFINED: Record<string, string> = {
  bool: "System.Boolean",
  byte: "System.Byte",
  sbyte: "System.SByte",
  char: "System.Char",
  decimal: "System.Decimal",
  double: "System.Double",
  float: "System.Single",
  int: "System.Int32",
  uint: "System.UInt32",
  long: "System.Int64",
  ulong: "System.UInt64",
  short: "System.Int16",
  ushort: "System.UInt16",
  object: "System.Object",
  string: "System.String",
  void: "System.Void",
  dynamic: "System.Object",
  nint: "System.IntPtr",
  nuint: "System.UIntPtr",
};

function modifiers(n: TsNode): Set<string> {
  const out = new Set<string>();
  for (const c of n.namedChildren) if (c.type === "modifier") out.add(c.text);
  return out;
}

function stringLiteral(n: TsNode | null): string | null {
  if (!n) return null;
  if (n.type === "string_literal") {
    let s = "";
    for (const c of n.namedChildren) {
      if (c.type === "string_literal_content") s += c.text;
      else if (c.type === "escape_sequence") s += unescape(c.text);
    }
    return s;
  }
  if (n.type === "verbatim_string_literal") return n.text.replace(/^@"/, "").replace(/"$/, "").replace(/""/g, '"');
  if (n.type === "raw_string_literal") return n.text.replace(/^"+/, "").replace(/"+$/, "");
  return null;
}

function unescape(e: string): string {
  const map: Record<string, string> = { "\\n": "\n", "\\t": "\t", "\\\\": "\\", '\\"': '"', "\\'": "'", "\\0": "\0", "\\r": "\r" };
  return map[e] ?? e.slice(1);
}

/** Attribute name without the `Attribute` suffix C# lets you omit. */
export function attrName(name: string): string {
  const bare = name.replace(/^global::/, "");
  return bare.endsWith("Attribute") ? bare.slice(0, -"Attribute".length) : bare;
}

function attributesOf(n: TsNode): { attrs: CsAttr[]; lists: TsNode[] } {
  const attrs: CsAttr[] = [];
  const lists: TsNode[] = [];
  for (const c of n.namedChildren) {
    if (c.type !== "attribute_list") continue;
    lists.push(c);
    for (const a of c.namedChildren) {
      if (a.type !== "attribute") continue;
      const name = a.childForFieldName("name")?.text.replace(/^@/, "");
      if (!name) continue;
      const args: string[] = [];
      const argList = a.namedChildren.find((x) => x.type === "attribute_argument_list");
      for (const arg of argList?.namedChildren ?? []) {
        if (arg.type !== "attribute_argument") continue;
        const v = arg.namedChildren[arg.namedChildren.length - 1];
        const lit = stringLiteral(v ?? null);
        if (lit !== null) args.push(lit);
        else if (v?.type === "typeof_expression") args.push(`typeof:${typeText(v.childForFieldName("type"))}`);
        else args.push(v ? v.text.replace(/\s+/g, " ") : "");
      }
      attrs.push(args.length ? { n: attrName(name), a: args } : { n: attrName(name) });
    }
  }
  return { attrs, lists };
}

function typeParamsOf(n: TsNode): string[] {
  const list = n.namedChildren.find((c) => c.type === "type_parameter_list");
  if (!list) return [];
  return list.namedChildren
    .filter((c) => c.type === "type_parameter")
    .map((c) => c.childForFieldName("name")?.text.replace(/^@/, "") ?? c.text)
    .filter(Boolean);
}

function constraintsOf(n: TsNode): Record<string, string[]> | undefined {
  let out: Record<string, string[]> | undefined;
  for (const c of n.namedChildren) {
    if (c.type !== "type_parameter_constraints_clause") continue;
    const target = c.namedChildren.find((x) => x.type === "identifier")?.text;
    if (!target) continue;
    const types: string[] = [];
    for (const k of c.namedChildren) {
      if (k.type !== "type_parameter_constraint") continue;
      const t = typeText(k.childForFieldName("type"));
      if (t) types.push(t);
    }
    if (types.length) (out ??= {})[target] = types;
  }
  return out;
}

/** Parameters of a method-like declaration, including the bare `params T[] xs`
 * shape this grammar emits without a `parameter` wrapper. */
function paramsOf(n: TsNode): { params: CsParam[]; variadic: boolean } {
  const list = n.childForFieldName("parameters") ?? n.namedChildren.find((c) => c.type === "parameter_list" || c.type === "bracketed_parameter_list");
  const params: CsParam[] = [];
  let variadic = false;
  if (!list) return { params, variadic };
  const kids = list.namedChildren;
  for (let i = 0; i < kids.length; i++) {
    const c = kids[i];
    if (c.type === "parameter") {
      const t = typeText(c.childForFieldName("type")) ?? "?";
      const name = c.childForFieldName("name")?.text.replace(/^@/, "") ?? "";
      const mod = c.namedChildren.find((x) => x.type === "modifier")?.text;
      const p: CsParam = mod ? { t, n: name, m: mod } : { t, n: name };
      if (c.children.some((x) => x.text === "=")) p.d = 1;
      params.push(p);
    } else if (c.type !== "identifier" && c.type !== "comment" && /type|name/.test(c.type)) {
      // `params int[] xs`: the type and the name are bare siblings.
      const nameNode = kids[i + 1];
      if (nameNode?.type === "identifier") {
        params.push({ t: typeText(c) ?? "?", n: nameNode.text, m: "params" });
        variadic = true;
        i++;
      }
    }
  }
  return { params, variadic };
}

// ── Unity string-ref methods ────────────────────────────────────────────────

/** Method names whose string arguments name something Unity resolves by name.
 * Classified by the resolver (which knows the receiver's type); extraction only
 * filters on the name so ordinary calls carry no extra payload. */
const UNITY_STRING_OPS = new Set([
  "Load", "LoadAll", "LoadAsync", // Resources
  "Find", // Shader.Find, GameObject.Find, transform.Find
  "LoadScene", "LoadSceneAsync", "GetSceneByName", "UnloadSceneAsync", "OpenScene", // scenes
  "LoadAssetAtPath", "LoadAllAssetsAtPath", "LoadMainAssetAtPath", "LoadPrefabContents", "ImportAsset", "AssetPathToGUID", // AssetDatabase
  "LoadAssetAsync", "LoadAssetsAsync", "InstantiateAsync", "LoadResourceLocationsAsync", // Addressables
  "SetTrigger", "ResetTrigger", "SetBool", "SetFloat", "SetInteger", "GetBool", "GetFloat", "GetInteger", "IsParameterControlledByCurve", // Animator params (also material SetFloat)
  "Play", "CrossFade", "CrossFadeInFixedTime", "PlayInFixedTime", "HasState", // Animator states
  "StringToHash", "PropertyToID",
  "SendMessage", "SendMessageUpwards", "BroadcastMessage", "Invoke", "InvokeRepeating", "CancelInvoke", "IsInvoking", "StartCoroutine", "StopCoroutine",
  "CompareTag", "FindWithTag", "FindGameObjectWithTag", "FindGameObjectsWithTag",
  "NameToLayer", "GetMask",
  "SetColor", "SetTexture", "SetVector", "SetInt", "SetMatrix", "SetBuffer", "GetColor", "GetTexture", "GetVector", "GetInt", "HasProperty", "HasFloat", "HasColor", "HasTexture",
  "EnableKeyword", "DisableKeyword", "IsKeywordEnabled",
  "SetGlobalFloat", "SetGlobalColor", "SetGlobalTexture", "SetGlobalVector", "SetGlobalInt", "SetGlobalMatrix",
  "FindAction", "FindActionMap", "AddBinding", "AddCompositeBinding", "With",
  "Q", "Query", // UI Toolkit element names
]);

/** LINQ / collection methods whose lambda parameter is an element of the receiver. */
const ELEMENT_LAMBDA = new Set([
  "ForEach", "Where", "Select", "SelectMany", "First", "FirstOrDefault", "Last", "LastOrDefault", "Single", "SingleOrDefault",
  "Any", "All", "Count", "Sum", "Min", "Max", "Average", "OrderBy", "OrderByDescending", "ThenBy", "ThenByDescending",
  "Find", "FindAll", "FindIndex", "FindLast", "Exists", "TrueForAll", "RemoveAll", "GroupBy", "ToDictionary", "ToLookup",
  "TakeWhile", "SkipWhile", "MinBy", "MaxBy", "DistinctBy", "Aggregate", "Sort",
]);

// ── Walk ────────────────────────────────────────────────────────────────────

interface Env {
  vars: Map<string, Expr | null | { lf: string }>;
  parent: Env | null;
}

function lookup(env: Env | null, name: string): Expr | null | { lf: string } | undefined {
  for (let e = env; e; e = e.parent) if (e.vars.has(name)) return e.vars.get(name);
  return undefined;
}

interface Ctx {
  rel: string;
  source: string;
  nodes: NodeV1[];
  edges: RawEdge[];
  facts: CsFacts;
  minted: Set<string>;
  /** Intents already emitted per source, for dedupe. */
  seen: Map<string, Set<string>>;
  pkg?: string;
  /** Local-function ids minted ahead of their declaration (they may be called first). */
  localFnIds: Map<number, string>;
  /** Input actions created in code, by the field/local they are assigned to. */
  actions: Map<string, NodeV1>;
}

interface Where {
  scope: string[]; // id scope segments
  parentId: string; // contains-edge source
  typeId?: string; // innermost type id
  typeName?: string;
  u: number; // using scope index
  /** Member whose body we're in (intent source). */
  memberId?: string;
}

const MAX_IR = 600;

function mint(base: string, minted: Set<string>): string {
  let id = base;
  let k = 2;
  while (minted.has(id)) id = `${base}~${k++}`;
  minted.add(id);
  return id;
}

/** Package that owns a repo path, for third-party code vendored into a Unity
 * project (`Packages/<name>/…` holding a package.json). The project's own code
 * lives under `Assets/`. */
function packageOf(rel: string): string | undefined {
  const m = rel.match(/^Packages\/([^/]+)\//);
  return m ? m[1] : undefined;
}

export function extractCSharp(rel: string, source: string): ExtractResult & { facts: { cs: CsFacts } } {
  if (!parser) throw new Error("C# grammar not warmed — call warmCSharp() first");
  let parsed = parse(source);
  if (parsed.root.hasError && /^\s*#\s*(if|else|elif)\b/m.test(source)) {
    const blanked = blankInactiveBranches(source);
    const retry = parse(blanked);
    if (!retry.root.hasError || errorCount(retry.root) < errorCount(parsed.root)) {
      parsed.done();
      parsed = retry;
    } else retry.done();
  }
  const root = parsed.root;
  const pkg = packageOf(rel);
  const facts: CsFacts = { scopes: [{ ns: "", usings: [], statics: [], aliases: [], parent: -1 }], types: [], members: [] };
  const fileNode: NodeV1 = {
    id: rel,
    name: basename(rel),
    kind: "file",
    path: rel,
    span: `L1-L${root.endPosition.row + 1}`,
    signature: null,
    exported: true,
    origin: "ast",
    body_hash: contentHash(source),
    chars: source.length,
    summary_state: "pending",
    summary: null,
    crux: null,
    ...(pkg ? { pkg } : {}),
  };
  const ctx: Ctx = {
    rel,
    source,
    nodes: [fileNode],
    edges: [],
    facts,
    minted: new Set([rel]),
    seen: new Map(),
    pkg,
    localFnIds: new Map(),
    actions: new Map(),
  };
  try {
    walkDecls(root.namedChildren, ctx, { scope: [], parentId: rel, u: 0 });
  } finally {
    parsed.done();
  }
  fileNode.body_text = fileResidual(source, ctx.nodes.slice(1));
  if (!facts.globalUsings?.length) delete facts.globalUsings;
  if (!facts.globalStatics?.length) delete facts.globalStatics;
  return { nodes: ctx.nodes, rawEdges: ctx.edges, facts: { cs: facts } };
}

function errorCount(n: TsNode): number {
  let c = 0;
  const visit = (x: TsNode) => {
    if (x.type === "ERROR" || x.isMissing) c++;
    if (x.hasError) for (const k of x.children) visit(k);
  };
  visit(n);
  return c;
}

function fileResidual(source: string, symbols: NodeV1[]): string {
  const lines = source.split("\n");
  const covered = new Uint8Array(lines.length + 2);
  for (const s of symbols) {
    const m = s.span.match(/^L(\d+)-L(\d+)$/);
    if (!m) continue;
    for (let r = Number(m[1]); r <= Number(m[2]) && r < covered.length; r++) covered[r] = 1;
  }
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) if (!covered[i + 1]) kept.push(lines[i]);
  return searchBody(kept.join(" "), MAX_FILE_BODY_CHARS);
}

const TYPE_DECLS: Record<string, Kind> = {
  class_declaration: "class",
  record_declaration: "class",
  record_struct_declaration: "struct",
  struct_declaration: "struct",
  interface_declaration: "interface",
  enum_declaration: "enum",
  delegate_declaration: "type",
};

/** Namespace-level walk: usings, namespaces, types; preprocessor wrappers are
 * transparent (their branches hold ordinary declarations). */
function walkDecls(children: TsNode[], ctx: Ctx, w: Where): void {
  let cur = w;
  for (const c of children) {
    switch (c.type) {
      case "using_directive":
        addUsing(c, ctx, cur.u);
        break;
      case "namespace_declaration": {
        const u = pushScope(ctx, cur.u, c.childForFieldName("name")?.text.replace(/^@/, "") ?? "");
        const body = c.childForFieldName("body");
        if (body) walkDecls(body.namedChildren, ctx, { ...cur, u });
        break;
      }
      case "file_scoped_namespace_declaration": {
        // Applies to every following sibling; its own named children (if the
        // grammar nests them) are walked too.
        const u = pushScope(ctx, cur.u, c.childForFieldName("name")?.text.replace(/^@/, "") ?? "");
        cur = { ...cur, u };
        const inner = c.namedChildren.filter((x) => x.type !== "qualified_name" && x.type !== "identifier");
        if (inner.length) walkDecls(inner, ctx, cur);
        break;
      }
      case "global_statement":
        walkBody(c, ctx, cur, { vars: new Map(), parent: null }, cur.parentId);
        break;
      default:
        if (TYPE_DECLS[c.type]) emitType(c, ctx, cur);
        else if (c.type.startsWith("preproc_") || c.type === "declaration_list") walkDecls(c.namedChildren, ctx, cur);
    }
  }
}

function pushScope(ctx: Ctx, parent: number, name: string): number {
  const p = ctx.facts.scopes[parent];
  const ns = [p.ns, name.replace(/\s+/g, "")].filter(Boolean).join(".");
  ctx.facts.scopes.push({ ns, usings: [], statics: [], aliases: [], parent });
  return ctx.facts.scopes.length - 1;
}

function addUsing(n: TsNode, ctx: Ctx, u: number): void {
  const tokens = n.children.filter((c) => !c.isNamed).map((c) => c.text);
  const isGlobal = tokens.includes("global");
  const isStatic = tokens.includes("static");
  const alias = n.childForFieldName("name")?.text.replace(/^@/, "");
  const target = n.namedChildren.filter((c) => c.type !== "identifier" || !alias || c.text !== alias).at(-1);
  const text = typeText(target ?? null);
  if (!text) return;
  const scope = ctx.facts.scopes[u];
  if (alias) scope.aliases.push([alias, text]);
  else if (isStatic) (isGlobal ? (ctx.facts.globalStatics ??= []) : scope.statics).push(text);
  else (isGlobal ? (ctx.facts.globalUsings ??= []) : scope.usings).push(text);
}

function isExported(mods: Set<string>, inInterface: boolean, topLevel: boolean): boolean {
  if (mods.has("public") || mods.has("protected") || mods.has("internal")) return true;
  if (mods.has("private")) return false;
  return inInterface || topLevel;
}

function sigStart(n: TsNode): number {
  for (const c of n.children) if (c.type !== "attribute_list" && c.type !== "comment") return c.startIndex;
  return n.startIndex;
}

function pushNode(
  ctx: Ctx,
  w: Where,
  node: TsNode,
  name: string,
  kind: Kind,
  headerEnd: number,
  extra: Partial<NodeV1> = {},
  idPart = name,
): string {
  const id = mint(`${ctx.rel}#${[...w.scope, idPart].join(".")}`, ctx.minted);
  // A `///` or `//` block right above a declaration describes it: search it with
  // the declaration (span and hash stay the declaration's own).
  const text = node.text;
  const doc = leadingComments(node);
  ctx.nodes.push({
    id,
    name,
    kind,
    path: ctx.rel,
    span: `L${node.startPosition.row + 1}-L${node.endPosition.row + 1}`,
    signature: clean(ctx.source.slice(sigStart(node), Math.max(sigStart(node), headerEnd))),
    exported: false,
    origin: "ast",
    body_hash: contentHash(text),
    body_text: searchBody(doc ? `${doc}\n${text}` : text),
    summary_state: "pending",
    summary: null,
    crux: null,
    ...extra,
    ...(ctx.pkg ? { pkg: ctx.pkg } : {}),
  });
  ctx.edges.push({ source: w.parentId, relation: "contains", targetId: id, file: ctx.rel });
  return id;
}

/** The comment block directly above a declaration (no blank line in between). */
function leadingComments(n: TsNode): string {
  const parts: string[] = [];
  let row = n.startPosition.row;
  let p = (n as unknown as { previousSibling: TsNode | null }).previousSibling;
  while (p && p.type === "comment" && row - p.endPosition.row <= 1) {
    parts.unshift(p.text);
    row = p.startPosition.row;
    p = (p as unknown as { previousSibling: TsNode | null }).previousSibling;
  }
  return parts.join("\n").replace(/^\s*\/\/\/?\s?|<\/?\w+[^>]*>/gm, "").trim();
}

function emitType(n: TsNode, ctx: Ctx, w: Where): void {
  const kind = TYPE_DECLS[n.type];
  const name = n.childForFieldName("name")?.text.replace(/^@/, "");
  if (!name) return;
  const mods = modifiers(n);
  const tparams = typeParamsOf(n);
  const body = n.childForFieldName("body") ?? n.namedChildren.find((c) => c.type === "declaration_list" || c.type === "enum_member_declaration_list");
  const outerIsInterface = w.typeId ? ctx.facts.types.find((t) => t.id === w.typeId)?.kind === "interface" : false;
  const headerEnd = body ? body.startIndex : n.endIndex;
  const id = pushNode(ctx, w, n, name, kind, headerEnd, {
    exported: isExported(mods, outerIsInterface, !w.typeId),
  });
  const { attrs, lists } = attributesOf(n);
  const bases: string[] = [];
  const baseList = n.namedChildren.find((c) => c.type === "base_list");
  for (const b of baseList?.namedChildren ?? []) {
    // `record B(int X) : A(X)` → primary_constructor_base_type(type, args)
    const t = b.type === "primary_constructor_base_type" ? typeText(b.childForFieldName("type") ?? b.namedChildren[0]) : typeText(b);
    if (t) bases.push(t);
  }
  const scope = ctx.facts.scopes[w.u];
  const fact: CsTypeFact = {
    id,
    name,
    arity: tparams.length,
    kind,
    ns: scope.ns,
    u: w.u,
    bases,
  };
  if (n.type === "record_declaration" || n.type === "record_struct_declaration") fact.record = true;
  if (w.typeId) fact.outer = w.typeId;
  if (mods.has("partial")) fact.partial = true;
  if (mods.has("static")) fact.static = true;
  if (mods.has("abstract")) fact.abstract = true;
  if (tparams.length) fact.tparams = tparams;
  const cons = constraintsOf(n);
  if (cons) fact.constraints = cons;
  if (attrs.length) fact.attrs = attrs;
  if (kind === "type") fact.ret = typeText(n.childForFieldName("type")) ?? undefined;
  ctx.facts.types.push(fact);

  const inner: Where = { scope: [...w.scope, name], parentId: id, typeId: id, typeName: name, u: w.u, memberId: id };
  // Heritage + attribute type references are resolved in the declaring context.
  for (const b of bases) intent(ctx, inner, id, "extends", { t: b });
  for (const a of attrs) intent(ctx, inner, id, "references", { t: `${a.n}Attribute`, via: "attribute" });
  for (const l of lists) walkBody(l, ctx, inner, { vars: new Map(), parent: null }, id);
  for (const c of Object.values(cons ?? {}).flat()) intent(ctx, inner, id, "references", { t: c });

  if (kind === "type") {
    // delegate: parameters/return are type references
    const { params } = paramsOf(n);
    for (const p of params) typeRef(ctx, inner, id, p.t);
    if (fact.ret) typeRef(ctx, inner, id, fact.ret);
    return;
  }
  // positional record parameters are properties
  if (fact.record) {
    const { params } = paramsOf(n);
    for (const p of params) {
      ctx.facts.members.push({ id: "", owner: id, name: p.n, mk: "prop", type: p.t });
      typeRef(ctx, inner, id, p.t);
    }
  }
  if (!body) return;
  if (kind === "enum") {
    for (const m of body.namedChildren) {
      if (m.type !== "enum_member_declaration") continue;
      const mn = m.childForFieldName("name")?.text.replace(/^@/, "");
      if (mn) ctx.facts.members.push({ id: "", owner: id, name: mn, mk: "enum", type: name, static: true });
    }
    return;
  }
  walkMembers(body.namedChildren, ctx, inner, kind === "interface");
}

function walkMembers(children: TsNode[], ctx: Ctx, w: Where, inInterface: boolean): void {
  for (const m of children) {
    if (TYPE_DECLS[m.type]) {
      emitType(m, ctx, w);
      continue;
    }
    if (m.type.startsWith("preproc_")) {
      walkMembers(m.namedChildren, ctx, w, inInterface);
      continue;
    }
    switch (m.type) {
      case "method_declaration":
      case "constructor_declaration":
      case "destructor_declaration":
      case "operator_declaration":
      case "conversion_operator_declaration":
        emitMethod(m, ctx, w, inInterface);
        break;
      case "property_declaration":
      case "indexer_declaration":
      case "event_declaration":
        emitProperty(m, ctx, w, inInterface);
        break;
      case "field_declaration":
      case "event_field_declaration":
        emitFields(m, ctx, w, inInterface);
        break;
    }
  }
}

function virtMod(mods: Set<string>): CsMemberFact["mod"] {
  if (mods.has("override")) return "override";
  if (mods.has("abstract")) return "abstract";
  if (mods.has("virtual")) return "virtual";
  if (mods.has("new")) return "new";
  return undefined;
}

function emitMethod(m: TsNode, ctx: Ctx, w: Where, inInterface: boolean): void {
  const mods = modifiers(m);
  let name: string;
  let mk: CsMemberKind = "method";
  let type: string | null = null;
  if (m.type === "constructor_declaration") {
    name = w.typeName ?? m.childForFieldName("name")?.text.replace(/^@/, "") ?? "";
    mk = mods.has("static") ? "cctor" : "ctor";
  } else if (m.type === "destructor_declaration") {
    name = `~${w.typeName ?? ""}`;
    mk = "dtor";
  } else if (m.type === "operator_declaration") {
    const op = m.children.find((c) => !c.isNamed && c.text !== "operator" && c.text !== "(" && c.text !== ")" && /^[^\w]+$|^(true|false)$/.test(c.text));
    name = `operator${op?.text ?? "?"}`;
    mk = "op";
    type = typeText(m.childForFieldName("type"));
  } else if (m.type === "conversion_operator_declaration") {
    type = typeText(m.childForFieldName("type"));
    name = `operator ${type ?? "?"}`;
    mk = "op";
  } else {
    name = m.childForFieldName("name")?.text.replace(/^@/, "") ?? "";
    type = typeText(m.childForFieldName("returns") ?? m.childForFieldName("type"));
  }
  if (!name) return;
  const body = m.childForFieldName("body") ?? m.namedChildren.find((c) => c.type === "block" || c.type === "arrow_expression_clause");
  const { params, variadic } = paramsOf(m);
  const iface = m.namedChildren.find((c) => c.type === "explicit_interface_specifier");
  const id = pushNode(ctx, w, m, name, "method", body ? body.startIndex : m.endIndex, {
    exported: isExported(mods, inInterface, false) || !!iface,
    owner: w.typeName,
    arity: params.length,
    ...(variadic ? { variadic: true } : {}),
  });
  const { attrs, lists } = attributesOf(m);
  const tparams = typeParamsOf(m);
  const fact: CsMemberFact = { id, owner: w.typeId!, name, mk };
  if (type) fact.type = type;
  if (mods.has("static") || mk === "cctor") fact.static = true;
  if (params.length) fact.params = params;
  if (params[0]?.m === "this") fact.ext = true;
  if (tparams.length) fact.tparams = tparams;
  const cons = constraintsOf(m);
  if (cons) fact.constraints = cons;
  const vm = virtMod(mods);
  if (vm) fact.mod = vm;
  if (inInterface && !body && !vm) fact.mod = "abstract";
  if (iface) fact.iface = typeText(iface.namedChildren[0]) ?? undefined;
  if (attrs.length) fact.attrs = attrs;
  ctx.facts.members.push(fact);

  const inner: Where = { ...w, scope: [...w.scope, name], parentId: id, memberId: id };
  const env: Env = { vars: new Map(), parent: null };
  for (const p of params) {
    env.vars.set(p.n, ["T", p.t]);
    typeRef(ctx, inner, id, p.t);
  }
  if (type) typeRef(ctx, inner, id, type);
  for (const a of attrs) intent(ctx, inner, id, "references", { t: `${a.n}Attribute`, via: "attribute" });
  for (const l of lists) walkBody(l, ctx, inner, env, id);
  if (fact.iface) intent(ctx, inner, id, "references", { t: fact.iface });
  // `: base(…)` / `: this(…)`
  const init = m.namedChildren.find((c) => c.type === "constructor_initializer");
  if (init) {
    const kw = init.children.find((c) => c.text === "base" || c.text === "this")?.text;
    const argc = init.namedChildren.find((c) => c.type === "argument_list")?.namedChildren.length ?? 0;
    if (kw) intent(ctx, inner, id, "calls", { e: ["c", [kw === "base" ? "b" : "t"], argc, [".ctor"]] });
    walkBody(init, ctx, inner, env, id);
  }
  if (body) walkBody(body, ctx, inner, env, id, type ? ["T", type] : undefined);
}

function emitProperty(m: TsNode, ctx: Ctx, w: Where, inInterface: boolean): void {
  const mods = modifiers(m);
  const isIndexer = m.type === "indexer_declaration";
  const isEvent = m.type === "event_declaration";
  const name = isIndexer ? "this[]" : (m.childForFieldName("name")?.text.replace(/^@/, "") ?? "");
  if (!name) return;
  const type = typeText(m.childForFieldName("type"));
  const accessors = m.childForFieldName("accessors") ?? m.namedChildren.find((c) => c.type === "accessor_list");
  const value = m.childForFieldName("value") ?? m.namedChildren.find((c) => c.type === "arrow_expression_clause");
  const headerEnd = accessors?.startIndex ?? value?.startIndex ?? m.endIndex;
  const { params } = isIndexer ? paramsOf(m) : { params: [] as CsParam[] };
  const iface = m.namedChildren.find((c) => c.type === "explicit_interface_specifier");
  const id = pushNode(ctx, w, m, name, isEvent ? "event" : "property", headerEnd, {
    exported: isExported(mods, inInterface, false) || !!iface,
    owner: w.typeName,
  });
  const { attrs, lists } = attributesOf(m);
  const fact: CsMemberFact = { id, owner: w.typeId!, name, mk: isIndexer ? "indexer" : isEvent ? "event" : "prop" };
  if (type) fact.type = type;
  if (mods.has("static")) fact.static = true;
  if (params.length) fact.params = params;
  const vm = virtMod(mods);
  if (vm) fact.mod = vm;
  if (inInterface && !vm && !accessors?.namedChildren.some((a) => a.childForFieldName("body"))) fact.mod = "abstract";
  if (iface) fact.iface = typeText(iface.namedChildren[0]) ?? undefined;
  if (attrs.length) fact.attrs = attrs;
  // `[field: SerializeField] public T X { get; private set; }` serializes the backing field.
  if (attrs.some((a) => a.n === "SerializeField" || a.n === "SerializeReference") && !mods.has("static")) fact.serialized = true;
  // `string Clip => Folder + Id;` — a computed name the resolver can still read a prefix of
  const valueExpr = value?.namedChildren[0] ?? (accessors?.namedChildren.length === 1 ? accessors.namedChildren[0].childForFieldName("body")?.namedChildren[0] : undefined);
  if (valueExpr && (type === "string" || type === "String")) {
    const sv = strValues(valueExpr.type === "return_statement" ? (valueExpr.namedChildren[0] ?? null) : valueExpr, null);
    if (sv.some((v) => v.some((p) => typeof p === "string" || Array.isArray(p)))) fact.sv = sv;
  }
  ctx.facts.members.push(fact);
  const inner: Where = { ...w, scope: [...w.scope, name], parentId: id, memberId: id };
  const env: Env = { vars: new Map(), parent: null };
  for (const p of params) env.vars.set(p.n, ["T", p.t]);
  if (type) {
    env.vars.set("value", ["T", type]);
    typeRef(ctx, inner, id, type);
  }
  for (const a of attrs) intent(ctx, inner, id, "references", { t: `${a.n}Attribute`, via: "attribute" });
  for (const l of lists) walkBody(l, ctx, inner, env, id);
  if (accessors) walkBody(accessors, ctx, inner, env, id, type ? ["T", type] : undefined);
  if (value) walkBody(value, ctx, inner, env, id, type ? ["T", type] : undefined);
  // auto-property initializer `= new();`
  for (const c of m.namedChildren) {
    if (c === accessors || c === value || c.type === "attribute_list" || c.type === "modifier") continue;
    if (c.type.endsWith("_expression") || c.type.endsWith("_literal")) walkBody(c, ctx, inner, env, id, type ? ["T", type] : undefined);
  }
}

function emitFields(m: TsNode, ctx: Ctx, w: Where, inInterface: boolean): void {
  const mods = modifiers(m);
  const isEvent = m.type === "event_field_declaration";
  const decl = m.namedChildren.find((c) => c.type === "variable_declaration");
  if (!decl) return;
  const type = typeText(decl.childForFieldName("type"));
  const { attrs, lists } = attributesOf(m);
  const isConst = mods.has("const");
  const serialized =
    !isEvent &&
    !isConst &&
    !mods.has("static") &&
    !mods.has("readonly") &&
    (mods.has("public") || attrs.some((a) => a.n === "SerializeField" || a.n === "SerializeReference")) &&
    !attrs.some((a) => a.n === "NonSerialized");
  const declarators = decl.namedChildren.filter((c) => c.type === "variable_declarator");
  for (const d of declarators) {
    const name = d.childForFieldName("name")?.text.replace(/^@/, "") ?? d.namedChildren[0]?.text;
    if (!name) continue;
    // Each declarator is its own node; the declaration's attributes and type are
    // shared, so the span is the whole declaration when it declares only one.
    const whole = declarators.length === 1 ? m : d;
    const id = pushNode(ctx, w, whole, name, isEvent ? "event" : isConst ? "constant" : "field", whole.endIndex, {
      exported: isExported(mods, inInterface, false),
      owner: w.typeName,
      ...(declarators.length > 1 ? { signature: clean(`${type ?? ""} ${name}`) } : {}),
    });
    if (declarators.length > 1) {
      // keep the declaration's text searchable on each declarator
      const node = ctx.nodes[ctx.nodes.length - 1];
      node.signature = clean(`${[...mods].join(" ")} ${type ?? ""} ${name}`);
    }
    const fact: CsMemberFact = { id, owner: w.typeId!, name, mk: isEvent ? "event" : isConst ? "const" : "field" };
    if (type) fact.type = type;
    if (mods.has("static") || isConst) fact.static = true;
    if (attrs.length) fact.attrs = attrs;
    if (serialized) fact.serialized = true;
    const init = d.namedChildren.find((c, i) => i > 0 && c.type !== "bracketed_argument_list");
    if (init && (isConst || (mods.has("static") && mods.has("readonly")) || mods.has("readonly") || mods.has("static"))) {
      const sv = strValues(init, null);
      if (sv.length && sv.some((v) => v.some((p) => typeof p === "string" || Array.isArray(p)))) fact.sv = sv;
      const hash = hashInit(init);
      if (hash) {
        fact.hash = hash.kind;
        fact.sv = hash.values;
      }
    }
    ctx.facts.members.push(fact);
    const inner: Where = { ...w, scope: [...w.scope, name], parentId: id, memberId: id };
    if (type) typeRef(ctx, inner, id, type);
    for (const a of attrs) intent(ctx, inner, id, "references", { t: `${a.n}Attribute`, via: "attribute" });
    const env: Env = { vars: new Map(), parent: null };
    for (const l of lists) walkBody(l, ctx, inner, env, id);
    if (init) {
      if (init.type === "implicit_object_creation_expression" && type) {
        intent(ctx, inner, id, "calls", { e: ["n", type, argCount(init)] });
        walkChildren(init, ctx, inner, env, id);
      } else walkBody(init, ctx, inner, env, id, type ? ["T", type] : undefined);
      // `x = new InputAction("Fire", …)`
      if (init.type === "object_creation_expression") maybeInputAction(init, ctx, inner, name);
    }
  }
}

/** `Animator.StringToHash("Attack")` / `Shader.PropertyToID("_Glow")` initialisers. */
function hashInit(n: TsNode): { kind: "anim" | "prop"; values: StrVal[] } | null {
  if (n.type !== "invocation_expression") return null;
  const fn = n.childForFieldName("function");
  const name = fn?.type === "member_access_expression" ? fn.childForFieldName("name")?.text.replace(/^@/, "") : fn?.text;
  if (name !== "StringToHash" && name !== "PropertyToID") return null;
  const arg = n.childForFieldName("arguments")?.namedChildren[0]?.namedChildren.at(-1) ?? null;
  const values = arg ? strValues(arg, null) : [];
  if (!values.length) return null;
  return { kind: name === "StringToHash" ? "anim" : "prop", values };
}

// ── Bodies ──────────────────────────────────────────────────────────────────

function argCount(n: TsNode): number {
  const args = n.childForFieldName("arguments") ?? n.namedChildren.find((c) => c.type === "argument_list");
  return args ? args.namedChildren.filter((c) => c.type === "argument").length : 0;
}

function emitOnce(ctx: Ctx, source: string, edge: RawEdge): void {
  let set = ctx.seen.get(source);
  if (!set) ctx.seen.set(source, (set = new Set()));
  const key = JSON.stringify([edge.relation, edge.cs, edge.unity]);
  if (set.has(key)) return;
  set.add(key);
  ctx.edges.push(edge);
}

function intent(ctx: Ctx, w: Where, source: string, relation: Relation, cs: Omit<CsIntent, "u" | "ty">): void {
  if (cs.e && JSON.stringify(cs.e).length > MAX_IR) return;
  const payload: CsIntent = { ...cs, u: w.u };
  if (w.typeId) payload.ty = w.typeId;
  emitOnce(ctx, source, { source, relation, file: ctx.rel, cs: payload });
}

const SKIP_TYPE_REFS = new Set(["var", "dynamic", ...Object.keys(PREDEFINED)]);

function typeRef(ctx: Ctx, w: Where, source: string, t: string | null): void {
  if (!t || SKIP_TYPE_REFS.has(t)) return;
  intent(ctx, w, source, "references", { t });
}

/** Expressions as IR. `env` maps locals to their own IR (substitution). */
function ir(n: TsNode | null | undefined, env: Env | null, depth = 0): Expr | null {
  if (!n || depth > 24) return null;
  switch (n.type) {
    case "identifier": {
      const v = lookup(env, n.text);
      if (v === undefined) return ["i", n.text.replace(/^@/, "")];
      if (v === null || !Array.isArray(v)) return null;
      return v;
    }
    case "this":
    case "this_expression":
      return ["t"];
    case "base":
    case "base_expression":
      return ["b"];
    case "predefined_type":
      return ["T", n.text];
    case "generic_name": {
      // A generic type used as an expression receiver: `List<int>.Empty`.
      return ["T", n.text.replace(/\s+/g, "")];
    }
    case "qualified_name":
    case "alias_qualified_name": {
      const q = n.childForFieldName("qualifier") ?? n.childForFieldName("alias");
      const name = n.childForFieldName("name")?.text.replace(/^@/, "");
      if (!name) return null;
      if (n.type === "alias_qualified_name" && q?.text === "global") return ["i", name];
      const r = ir(q, env, depth + 1);
      return r ? ["m", r, name] : ["i", name];
    }
    case "member_access_expression": {
      const obj = n.childForFieldName("expression");
      const nameNode = n.childForFieldName("name");
      const name = (nameNode?.type === "generic_name" ? nameNode.namedChildren[0]?.text : nameNode?.text)?.replace(/^@/, "");
      if (!name) return null;
      if (!obj) return null;
      const r = ir(obj, env, depth + 1);
      return r ? ["m", r, name] : null;
    }
    case "conditional_access_expression": {
      const cond = n.childForFieldName("condition") ?? n.namedChildren[0];
      const binding = n.namedChildren.find((c) => c.type === "member_binding_expression");
      const name = binding?.childForFieldName("name");
      const nm = name?.type === "generic_name" ? name.namedChildren[0]?.text : name?.text;
      const r = ir(cond, env, depth + 1);
      return r && nm ? ["m", r, nm] : r;
    }
    case "invocation_expression":
      return withFirstArg(callIr(n, env, depth), n, env, depth);
    case "object_creation_expression": {
      const t = typeText(n.childForFieldName("type"));
      return t ? ["n", t, argCount(n)] : null;
    }
    case "implicit_object_creation_expression":
      return null; // needs a target type — handled where one is known
    case "array_creation_expression":
      return ["T", typeText(n.childForFieldName("type")) ?? "?"];
    case "element_access_expression": {
      const r = ir(n.childForFieldName("expression"), env, depth + 1);
      return r ? ["x", r] : null;
    }
    case "cast_expression":
      return ["T", typeText(n.childForFieldName("type")) ?? "?"];
    case "as_expression": {
      const t = typeText(n.childForFieldName("right"));
      return t ? ["T", t] : null;
    }
    case "parenthesized_expression":
    case "checked_expression":
    case "postfix_unary_expression": // `x!`
      return ir(n.namedChildren[0], env, depth + 1);
    case "await_expression": {
      const r = ir(n.namedChildren[0], env, depth + 1);
      return r ? ["a", r] : null;
    }
    case "conditional_expression":
      return ir(n.childForFieldName("consequence"), env, depth + 1) ?? ir(n.childForFieldName("alternative"), env, depth + 1);
    case "binary_expression": {
      const op = n.children.find((c) => !c.isNamed)?.text;
      if (op === "??") return ir(n.childForFieldName("left"), env, depth + 1) ?? ir(n.childForFieldName("right"), env, depth + 1);
      if (op === "+" && (isStringy(n.childForFieldName("left")) || isStringy(n.childForFieldName("right")))) return ["T", "string"];
      return null;
    }
    case "string_literal":
    case "verbatim_string_literal":
    case "interpolated_string_expression":
    case "raw_string_literal":
      return ["T", "string"];
    case "typeof_expression":
      return ["T", "System.Type"];
    case "default_expression": {
      const t = typeText(n.childForFieldName("type"));
      return t ? ["T", t] : null;
    }
    case "with_expression":
      return ir(n.namedChildren[0], env, depth + 1);
    default:
      return null;
  }
}

function isStringy(n: TsNode | null): boolean {
  return !!n && (n.type === "string_literal" || n.type === "verbatim_string_literal" || n.type === "interpolated_string_expression");
}

function genericArgs(nameNode: TsNode | null | undefined): string[] | undefined {
  if (nameNode?.type !== "generic_name") return undefined;
  const list = nameNode.namedChildren.find((c) => c.type === "type_argument_list");
  const out = list?.namedChildren.map((c) => typeText(c) ?? "?") ?? [];
  return out.length ? out : undefined;
}

function callIr(n: TsNode, env: Env | null, depth: number): Expr | null {
  const fn = n.childForFieldName("function");
  if (!fn) return null;
  const argc = argCount(n);
  if (fn.type === "identifier") {
    const v = lookup(env, fn.text);
    if (v !== undefined) return null; // a delegate local/parameter being invoked
    return ["c", ["i", fn.text], argc];
  }
  if (fn.type === "generic_name") {
    const name = fn.namedChildren[0]?.text;
    return name ? withTargs(["c", ["i", name], argc], genericArgs(fn)) : null;
  }
  if (fn.type === "member_access_expression") {
    const obj = fn.childForFieldName("expression");
    const nameNode = fn.childForFieldName("name");
    const name = nameNode?.type === "generic_name" ? nameNode.namedChildren[0]?.text : nameNode?.text;
    if (!name || !obj) return null;
    const r = ir(obj, env, depth + 1);
    if (!r) return null;
    return withTargs(["c", ["m", r, name], argc], genericArgs(nameNode));
  }
  if (fn.type === "conditional_access_expression") {
    const cond = fn.childForFieldName("condition") ?? fn.namedChildren[0];
    const binding = fn.namedChildren.find((c) => c.type === "member_binding_expression");
    const nameNode = binding?.childForFieldName("name");
    const name = nameNode?.type === "generic_name" ? nameNode.namedChildren[0]?.text : nameNode?.text;
    const r = ir(cond, env, depth + 1);
    if (!name || !r) return null;
    return withTargs(["c", ["m", r, name], argc], genericArgs(nameNode));
  }
  return null;
}

function withTargs(e: ["c", Expr, number], targs: string[] | undefined): Expr {
  return targs ? ["c", e[1], e[2], targs] : e;
}

/** `Instantiate(prefab)` returns the type of its argument; keep that argument. */
function withFirstArg(e: Expr | null, call: TsNode, env: Env | null, depth: number): Expr | null {
  if (!e || e[0] !== "c" || e[3]) return e;
  const fn = e[1];
  const name = fn[0] === "i" ? fn[1] : fn[0] === "m" ? fn[2] : null;
  if (name !== "Instantiate") return e;
  const a0 = call.childForFieldName("arguments")?.namedChildren.find((a) => a.type === "argument")?.namedChildren.at(-1);
  const r = a0 ? ir(a0, env, depth + 1) : null;
  return r ? ["c", fn, e[2], undefined, r] : e;
}

/** The possible string values of an expression. */
function strValues(n: TsNode | null, env: Env | null, depth = 0): StrVal[] {
  if (!n || depth > 8) return [];
  const lit = stringLiteral(n);
  if (lit !== null) return [[lit]];
  switch (n.type) {
    case "interpolated_string_expression":
    case "interpolated_verbatim_string_expression": {
      const parts: StrVal = [];
      for (const c of n.namedChildren) {
        if (c.type === "string_content" || c.type === "interpolated_string_text") parts.push(c.text);
        else if (c.type === "interpolation") {
          const inner = c.namedChildren.find((x) => x.type !== "interpolation_brace" && x.type !== "interpolation_alignment_clause" && x.type !== "interpolation_format_clause");
          const v = inner ? strValues(inner, env, depth + 1) : [];
          if (v.length === 1) parts.push(...v[0]);
          else parts.push(null);
        }
      }
      return [parts];
    }
    case "binary_expression": {
      const op = n.children.find((c) => !c.isNamed)?.text;
      if (op === "??") return [...strValues(n.childForFieldName("left"), env, depth + 1), ...strValues(n.childForFieldName("right"), env, depth + 1)];
      if (op !== "+") return [];
      const l = strValues(n.childForFieldName("left"), env, depth + 1);
      const r = strValues(n.childForFieldName("right"), env, depth + 1);
      const L = l.length ? l : [[null]];
      const R = r.length ? r : [[null]];
      const out: StrVal[] = [];
      for (const a of L) for (const b of R) if (out.length < 16) out.push([...a, ...b]);
      return out;
    }
    case "conditional_expression":
      return [...strValues(n.childForFieldName("consequence"), env, depth + 1), ...strValues(n.childForFieldName("alternative"), env, depth + 1)];
    case "parenthesized_expression":
      return strValues(n.namedChildren[0], env, depth + 1);
    case "initializer_expression":
    case "implicit_array_creation_expression":
    case "array_creation_expression":
    case "collection_expression": {
      const out: StrVal[] = [];
      const visit = (x: TsNode) => {
        for (const c of x.namedChildren) {
          if (c.type === "initializer_expression") visit(c);
          else out.push(...strValues(c, env, depth + 1));
        }
      };
      visit(n);
      return out;
    }
    case "invocation_expression": {
      const fn = n.childForFieldName("function");
      const name = fn?.type === "member_access_expression" ? fn.childForFieldName("name")?.text.replace(/^@/, "") : fn?.text;
      const args = n.childForFieldName("arguments")?.namedChildren ?? [];
      if (name === "nameof") {
        const a = args[0]?.namedChildren.at(-1);
        const last = a?.text.split(".").pop();
        return last ? [[last]] : [];
      }
      if ((name === "ToLowerInvariant" || name === "ToLower" || name === "ToUpperInvariant" || name === "ToUpper" || name === "Trim") && fn?.type === "member_access_expression") {
        return strValues(fn.childForFieldName("expression"), env, depth + 1).map((v) =>
          v.map((p) => (typeof p === "string" ? (name.includes("Lower") ? p.toLowerCase() : name.includes("Upper") ? p.toUpperCase() : p.trim()) : p)),
        );
      }
      if (name === "Combine" || name === "Join") return [];
      return [[null]];
    }
    case "identifier": {
      const v = lookup(env, n.text);
      if (v !== undefined) return [[null]]; // a local: value unknown statically
      return [[["r", ["i", n.text]]]];
    }
    case "integer_literal":
      return [[`#${n.text}`]]; // `LoadScene(0)`: a build index, marked so it is never read as a name
    case "member_access_expression": {
      const e = ir(n, env);
      return e ? [[["r", e]]] : [[null]];
    }
    case "element_access_expression": {
      // `Paths[i]` → every element of a constant array
      const e = ir(n.childForFieldName("expression"), env);
      return e ? [[["r", e]]] : [[null]];
    }
    default:
      return [[null]];
  }
}

/** Walk statements/expressions of one member body, emitting intents. */
function walkBody(n: TsNode, ctx: Ctx, w: Where, env: Env, source: string, ret?: Expr): void {
  switch (n.type) {
    case "block": {
      const scoped: Env = { vars: new Map(), parent: env };
      // local functions are visible across the whole block
      for (const c of n.namedChildren) {
        if (c.type === "local_function_statement") {
          const name = c.childForFieldName("name")?.text.replace(/^@/, "");
          if (!name) continue;
          const id = mint(`${ctx.rel}#${[...w.scope, name].join(".")}`, ctx.minted);
          ctx.localFnIds.set(c.startIndex, id);
          scoped.vars.set(name, { lf: id });
        }
      }
      for (const c of n.namedChildren) walkBody(c, ctx, w, scoped, source, ret);
      return;
    }
    case "local_function_statement": {
      const name = n.childForFieldName("name")?.text.replace(/^@/, "") ?? "";
      let id = ctx.localFnIds.get(n.startIndex);
      if (!id) {
        id = mint(`${ctx.rel}#${[...w.scope, name].join(".")}`, ctx.minted);
        env.vars.set(name, { lf: id });
      }
      const body = n.childForFieldName("body");
      const type = typeText(n.childForFieldName("type"));
      const { params, variadic } = paramsOf(n);
      ctx.minted.delete(id); // pushNode re-mints the same id
      const pushed = pushNode(ctx, { ...w, parentId: source }, n, name, "function", body ? body.startIndex : n.endIndex, {
        arity: params.length,
        ...(variadic ? { variadic: true } : {}),
      });
      const fact: CsMemberFact = { id: pushed, owner: w.typeId!, name, mk: "local" };
      if (type) fact.type = type;
      if (params.length) fact.params = params;
      ctx.facts.members.push(fact);
      const inner: Where = { ...w, scope: [...w.scope, name], parentId: pushed, memberId: pushed };
      const fenv: Env = { vars: new Map(), parent: env };
      for (const p of params) {
        fenv.vars.set(p.n, ["T", p.t]);
        typeRef(ctx, inner, pushed, p.t);
      }
      if (type) typeRef(ctx, inner, pushed, type);
      if (body) walkBody(body, ctx, inner, fenv, pushed, type ? ["T", type] : undefined);
      return;
    }
    case "local_declaration_statement":
    case "variable_declaration":
    case "field_declaration": {
      const decl = n.type === "variable_declaration" ? n : n.namedChildren.find((c) => c.type === "variable_declaration");
      if (!decl) return walkChildren(n, ctx, w, env, source, ret);
      const tnode = decl.childForFieldName("type");
      const t = typeText(tnode);
      if (t) typeRef(ctx, w, source, t);
      for (const d of decl.namedChildren) {
        if (d.type !== "variable_declarator") continue;
        const tuple = d.namedChildren[0]?.type === "tuple_pattern" ? d.namedChildren[0] : null;
        const name = tuple ? null : (d.childForFieldName("name")?.text.replace(/^@/, "") ?? d.namedChildren[0]?.text);
        const init = d.namedChildren.find((c, i) => i > 0 && c.type !== "bracketed_argument_list");
        if (tuple) {
          // `var (boss, kit) = Boss(…)`: each name is an element of the tuple
          if (init) walkBody(init, ctx, w, env, source, ret);
          const r = init ? ir(init, env) : null;
          tuple.namedChildren.filter((c) => c.type === "identifier").forEach((c, i) => env.vars.set(c.text, r ? ["tu", r, i] : null));
          continue;
        }
        if (init) {
          if (init.type === "implicit_object_creation_expression" && t) {
            intent(ctx, w, source, "calls", { e: ["n", t, argCount(init)] });
            walkChildren(init, ctx, w, env, source, ret);
          } else walkBody(init, ctx, w, env, source, ret);
          if (init.type === "object_creation_expression" && name) maybeInputAction(init, ctx, w, name);
        }
        if (name) env.vars.set(name, t ? ["T", t] : init ? ir(init, env) : null);
      }
      return;
    }
    case "foreach_statement": {
      const scoped: Env = { vars: new Map(), parent: env };
      const right = n.childForFieldName("right");
      const left = n.childForFieldName("left");
      const t = typeText(n.childForFieldName("type"));
      if (right) walkBody(right, ctx, w, env, source, ret);
      const coll = ir(right, env);
      if (left?.type === "identifier") scoped.vars.set(left.text, t ? ["T", t] : coll ? ["e", coll] : null);
      else if (left) {
        const names = left.namedChildren.filter((c) => c.type === "identifier").map((c) => c.text);
        // `foreach (var (k, v) in dict)` deconstructs a KeyValuePair.
        names.forEach((nm, i) =>
          scoped.vars.set(nm, coll && names.length === 2 ? ["m", ["e", coll], i === 0 ? "Key" : "Value"] : null),
        );
      }
      if (t) typeRef(ctx, w, source, t);
      const body = n.childForFieldName("body");
      if (body) walkBody(body, ctx, w, scoped, source, ret);
      return;
    }
    case "for_statement":
    case "using_statement":
    case "fixed_statement": {
      const scoped: Env = { vars: new Map(), parent: env };
      for (const c of n.namedChildren) walkBody(c, ctx, w, scoped, source, ret);
      return;
    }
    case "catch_clause": {
      const scoped: Env = { vars: new Map(), parent: env };
      const decl = n.namedChildren.find((c) => c.type === "catch_declaration");
      if (decl) {
        const t = typeText(decl.childForFieldName("type"));
        const nm = decl.childForFieldName("name")?.text.replace(/^@/, "");
        if (t) typeRef(ctx, w, source, t);
        if (nm && t) scoped.vars.set(nm, ["T", t]);
      }
      for (const c of n.namedChildren) if (c !== decl) walkBody(c, ctx, w, scoped, source, ret);
      return;
    }
    case "declaration_pattern":
    case "declaration_expression": {
      const t = typeText(n.childForFieldName("type"));
      const nm = n.childForFieldName("name")?.text.replace(/^@/, "");
      if (t) typeRef(ctx, w, source, t);
      if (nm) env.vars.set(nm, t ? ["T", t] : outVarType(n, env));
      return;
    }
    case "recursive_pattern": {
      const t = typeText(n.childForFieldName("type"));
      if (t) typeRef(ctx, w, source, t);
      const des = n.namedChildren.find((c) => c.type === "identifier" && c !== n.childForFieldName("type"));
      if (des && t) env.vars.set(des.text, ["T", t]);
      for (const c of n.namedChildren) if (c.type !== "identifier") walkBody(c, ctx, w, env, source, ret);
      return;
    }
    case "constant_pattern": {
      // `x is Walker` parses as a constant pattern naming a type
      const c = n.namedChildren[0];
      if (c && (c.type === "identifier" || c.type === "qualified_name" || c.type === "generic_name")) {
        intent(ctx, w, source, "references", { e: ir(c, env) ?? ["i", c.text] });
        return;
      }
      return walkChildren(n, ctx, w, env, source, ret);
    }
    case "type_pattern": {
      const t = typeText(n.namedChildren[0]);
      if (t) typeRef(ctx, w, source, t);
      return;
    }
    case "lambda_expression":
    case "anonymous_method_expression": {
      const scoped: Env = { vars: new Map(), parent: env };
      const ps = n.childForFieldName("parameters") ?? n.namedChildren.find((c) => c.type === "parameter_list");
      const implicit: string[] = [];
      if (ps?.type === "implicit_parameter" || ps?.type === "identifier") implicit.push(ps.text);
      else
        for (const p of ps?.namedChildren ?? []) {
          const t = typeText(p.childForFieldName("type"));
          const nm = p.childForFieldName("name")?.text.replace(/^@/, "") ?? (p.type === "identifier" || p.type === "implicit_parameter" ? p.text : undefined);
          if (!nm) continue;
          if (t) {
            scoped.vars.set(nm, ["T", t]);
            typeRef(ctx, w, source, t);
          } else implicit.push(nm);
        }
      const elem = lambdaElement(n, env);
      implicit.forEach((nm, i) => scoped.vars.set(nm, i === 0 ? elem : null));
      const body = n.childForFieldName("body") ?? n.namedChildren.find((c) => c.type === "block");
      if (body) walkBody(body, ctx, w, scoped, source, undefined);
      return;
    }
    case "query_expression": {
      const scoped: Env = { vars: new Map(), parent: env };
      for (const c of n.namedChildren) {
        if (c.type === "from_clause" || c.type === "join_clause") {
          const nm = c.childForFieldName("name")?.text.replace(/^@/, "");
          const src = c.namedChildren.filter((x) => x.type !== "identifier" || x.text !== nm).at(-1);
          if (src) walkBody(src, ctx, w, scoped, source, ret);
          const coll = ir(src, scoped);
          if (nm) scoped.vars.set(nm, coll ? ["e", coll] : null);
        } else if (c.type === "let_clause") {
          const nm = c.namedChildren[0]?.text;
          const val = c.namedChildren[1];
          if (val) walkBody(val, ctx, w, scoped, source, ret);
          if (nm) scoped.vars.set(nm, ir(val, scoped));
        } else walkBody(c, ctx, w, scoped, source, ret);
      }
      return;
    }
    case "return_statement":
    case "arrow_expression_clause": {
      const e = n.namedChildren[0];
      if (e?.type === "implicit_object_creation_expression" && ret) {
        intent(ctx, w, source, "calls", { e: ["N", ret, argCount(e)] });
        return walkChildren(e, ctx, w, env, source, ret);
      }
      return walkChildren(n, ctx, w, env, source, ret);
    }
    case "invocation_expression":
      return visitInvocation(n, ctx, w, env, source, ret);
    case "object_creation_expression": {
      const t = typeText(n.childForFieldName("type"));
      if (t) {
        intent(ctx, w, source, "calls", { e: ["n", t, argCount(n)] });
        typeRef(ctx, w, source, t);
      }
      const args = n.childForFieldName("arguments");
      if (args) walkArgs(args, ctx, w, env, source, ret);
      const initializer = n.childForFieldName("initializer") ?? n.namedChildren.find((c) => c.type === "initializer_expression");
      if (initializer) walkInitializer(initializer, t ? ["T", t] : null, ctx, w, env, source, ret);
      return;
    }
    case "implicit_object_creation_expression": {
      const args = n.childForFieldName("arguments") ?? n.namedChildren.find((c) => c.type === "argument_list");
      if (args) walkArgs(args, ctx, w, env, source, ret);
      const initializer = n.namedChildren.find((c) => c.type === "initializer_expression");
      if (initializer) walkChildren(initializer, ctx, w, env, source, ret);
      return;
    }
    case "assignment_expression": {
      const left = n.childForFieldName("left");
      const right = n.childForFieldName("right");
      const op = n.children.find((c) => !c.isNamed && /=/.test(c.text))?.text;
      if ((op === "+=" || op === "-=") && right && isMethodGroup(right, env)) {
        const handler = ir(right, env);
        if (handler && op === "+=") intent(ctx, w, source, "subscribes", { e: ["g", handler], via: left?.text.replace(/\s+/g, "") });
        if (left) walkBody(left, ctx, w, env, source, ret);
        return;
      }
      if (right?.type === "implicit_object_creation_expression" && left) {
        const target = ir(left, env);
        if (target) intent(ctx, w, source, "calls", { e: ["N", target, argCount(right)] });
        walkBody(left, ctx, w, env, source, ret);
        walkChildren(right, ctx, w, env, source, ret);
        return;
      }
      if (left) walkBody(left, ctx, w, env, source, ret);
      if (right) walkBody(right, ctx, w, env, source, ret);
      // `strike = new InputAction("Melee", …)` assigns a field or local
      if (right?.type === "object_creation_expression" && left) {
        const nm = left.type === "identifier" ? left.text : left.childForFieldName("name")?.text.replace(/^@/, "");
        if (nm) maybeInputAction(right, ctx, w, nm);
      }
      return;
    }
    case "member_access_expression": {
      const e = ir(n, env);
      if (e) intent(ctx, w, source, "references", { e });
      // receiver may itself contain calls (`GetX().Y`)
      const obj = n.childForFieldName("expression");
      if (obj && obj.type !== "identifier" && obj.type !== "member_access_expression") walkBody(obj, ctx, w, env, source, ret);
      else if (obj?.type === "member_access_expression") walkInnerCalls(obj, ctx, w, env, source, ret);
      return;
    }
    case "conditional_access_expression": {
      const e = ir(n, env);
      if (e) intent(ctx, w, source, "references", { e });
      const cond = n.childForFieldName("condition") ?? n.namedChildren[0];
      if (cond) walkBody(cond, ctx, w, env, source, ret);
      return;
    }
    case "identifier": {
      if (lookup(env, n.text) !== undefined) return;
      intent(ctx, w, source, "references", { e: ["i", n.text] });
      return;
    }
    case "typeof_expression":
    case "default_expression":
    case "sizeof_expression": {
      const t = typeText(n.childForFieldName("type") ?? n.namedChildren[0]);
      if (t) typeRef(ctx, w, source, t);
      return;
    }
    case "cast_expression": {
      typeRef(ctx, w, source, typeText(n.childForFieldName("type")));
      const v = n.childForFieldName("value");
      if (v) walkBody(v, ctx, w, env, source, ret);
      return;
    }
    case "as_expression":
    case "is_expression": {
      const l = n.childForFieldName("left") ?? n.namedChildren[0];
      const r = n.childForFieldName("right") ?? n.namedChildren[1];
      if (l) walkBody(l, ctx, w, env, source, ret);
      typeRef(ctx, w, source, typeText(r));
      return;
    }
    case "array_creation_expression": {
      const t = n.childForFieldName("type");
      typeRef(ctx, w, source, typeText(t?.childForFieldName("type") ?? t));
      return walkChildren(n, ctx, w, env, source, ret);
    }
    case "binary_expression": {
      // `x.tag == "Player"` names a tag
      const op = n.children.find((c) => !c.isNamed)?.text;
      if (op === "==" || op === "!=") {
        const l = n.childForFieldName("left");
        const r = n.childForFieldName("right");
        for (const [a, b] of [[l, r], [r, l]] as const) {
          if (a && b && (a.type === "member_access_expression" ? a.childForFieldName("name")?.text.replace(/^@/, "") === "tag" : a.text === "tag")) {
            const v = strValues(b, env);
            if (v.length) unityIntent(ctx, w, source, { op: "tag==", args: [v] });
          }
        }
      }
      return walkChildren(n, ctx, w, env, source, ret);
    }
    case "attribute_list":
    case "attribute_argument_list":
    case "attribute_argument":
      return walkChildren(n, ctx, w, env, source, ret);
    case "attribute": {
      // the attribute's own name is a type reference (emitted from its fact);
      // only its arguments can reference members (`[Range(0, Max)]`)
      const args = n.namedChildren.find((c) => c.type === "attribute_argument_list");
      if (args) walkChildren(args, ctx, w, env, source, ret);
      return;
    }
    case "generic_name": {
      // a generic method group or type used as an expression
      for (const a of genericArgs(n) ?? []) typeRef(ctx, w, source, a);
      return;
    }
    case "string_literal":
    case "verbatim_string_literal": {
      // "Assets/…" / "Packages/…" names a project asset or folder outright
      const v = stringLiteral(n);
      if (v && /^(Assets|Packages|ProjectSettings)\/./.test(v) && !insideUnityOp(n)) unityIntent(ctx, w, source, { op: "path", args: [[[v]]] });
      return;
    }
    case "interpolated_string_expression": {
      const vals = strValues(n, env);
      if (vals.some((sv) => typeof sv[0] === "string" && /^(Assets|Packages|ProjectSettings)\/./.test(sv[0])) && !insideUnityOp(n)) unityIntent(ctx, w, source, { op: "path", args: [vals] });
      return walkChildren(n, ctx, w, env, source, ret);
    }
    case "integer_literal":
    case "real_literal":
    case "boolean_literal":
    case "null_literal":
    case "character_literal":
    case "comment":
    case "predefined_type":
      return;
    default:
      return walkChildren(n, ctx, w, env, source, ret);
  }
}

/** Is this literal an argument of a call the Unity string-ops already cover? */
function insideUnityOp(n: TsNode): boolean {
  const arg = n.parent;
  const call = arg?.type === "argument" ? arg.parent?.parent : null;
  if (call?.type !== "invocation_expression") return false;
  const fn = call.childForFieldName("function");
  const nameNode = fn?.type === "member_access_expression" ? fn.childForFieldName("name") : fn;
  const name = nameNode?.type === "generic_name" ? nameNode.namedChildren[0]?.text : nameNode?.text;
  return !!name && UNITY_STRING_OPS.has(name);
}

function walkChildren(n: TsNode, ctx: Ctx, w: Where, env: Env, source: string, ret?: Expr): void {
  for (const c of n.namedChildren) walkBody(c, ctx, w, env, source, ret);
}

/** Inside a member-access chain only the calls matter (the chain itself was
 * emitted as one reference by its outermost access). */
function walkInnerCalls(n: TsNode, ctx: Ctx, w: Where, env: Env, source: string, ret?: Expr): void {
  if (n.type === "member_access_expression") {
    const obj = n.childForFieldName("expression");
    if (obj) walkInnerCalls(obj, ctx, w, env, source, ret);
    return;
  }
  if (n.type === "identifier" || n.type === "this" || n.type === "base") return;
  walkBody(n, ctx, w, env, source, ret);
}

function walkArgs(args: TsNode, ctx: Ctx, w: Where, env: Env, source: string, ret?: Expr): void {
  for (const a of args.namedChildren) {
    if (a.type !== "argument") continue;
    const v = a.namedChildren.at(-1);
    if (!v) continue;
    // A method group passed as a delegate (`Array.Sort(xs, Compare)`) is a reference to it.
    if (isMethodGroup(v, env)) {
      const e = ir(v, env);
      if (e) intent(ctx, w, source, "references", { e: ["g", e] });
      if (v.type === "member_access_expression") walkInnerCalls(v, ctx, w, env, source, ret);
      continue;
    }
    walkBody(v, ctx, w, env, source, ret);
  }
}

function walkInitializer(init: TsNode, created: Expr | null, ctx: Ctx, w: Where, env: Env, source: string, ret?: Expr): void {
  for (const c of init.namedChildren) {
    if (c.type === "assignment_expression" && created) {
      const left = c.childForFieldName("left");
      const right = c.childForFieldName("right");
      if (left?.type === "identifier") intent(ctx, w, source, "references", { e: ["m", created, left.text] });
      if (right) walkBody(right, ctx, w, env, source, ret);
    } else walkBody(c, ctx, w, env, source, ret);
  }
}

/** Could this argument be a method group? A bare name or member access that is
 * not a local (locals are values). The resolver keeps it only if it names a method. */
function isMethodGroup(n: TsNode, env: Env | null): boolean {
  if (n.type === "identifier") {
    const v = lookup(env, n.text);
    return v === undefined || (v !== null && !Array.isArray(v));
  }
  return n.type === "member_access_expression" || n.type === "qualified_name";
}

/** The element a lambda's implicit parameter ranges over, when the lambda is an
 * argument to a LINQ/collection method on a typed receiver. */
function lambdaElement(lambda: TsNode, env: Env | null): Expr | null {
  const arg = lambda.parent;
  const list = arg?.parent;
  const call = list?.parent;
  if (arg?.type !== "argument" || list?.type !== "argument_list" || call?.type !== "invocation_expression") return null;
  const fn = call.childForFieldName("function");
  if (fn?.type !== "member_access_expression") return null;
  const name = fn.childForFieldName("name");
  const nm = name?.type === "generic_name" ? name.namedChildren[0]?.text : name?.text;
  if (!nm || !ELEMENT_LAMBDA.has(nm)) return null;
  const recv = ir(fn.childForFieldName("expression"), env);
  return recv ? ["e", recv] : null;
}

/** `out var x`: typed by the call it is passed to. */
function outVarType(decl: TsNode, env: Env | null): Expr | null {
  const arg = decl.parent;
  const call = arg?.parent?.parent;
  if (arg?.type !== "argument" || call?.type !== "invocation_expression") return null;
  const fn = call.childForFieldName("function");
  const nameNode = fn?.type === "member_access_expression" ? fn.childForFieldName("name") : fn;
  const nm = nameNode?.type === "generic_name" ? nameNode.namedChildren[0]?.text : nameNode?.text;
  const targs = genericArgs(nameNode);
  if (nm === "TryGetComponent" || nm === "TryGetComponentInChildren" || nm === "TryFindObjectOfType") return targs ? ["T", targs[0]] : null;
  const recv = fn?.type === "member_access_expression" ? ir(fn.childForFieldName("expression"), env) : null;
  if (!recv) return null;
  if (nm === "TryGetValue" || nm === "Remove" || nm === "TryRemove") return ["dv", recv];
  if (nm === "TryPeek" || nm === "TryDequeue" || nm === "TryPop" || nm === "TryTake") return ["e", recv];
  return null;
}

function visitInvocation(n: TsNode, ctx: Ctx, w: Where, env: Env, source: string, ret?: Expr): void {
  const fn = n.childForFieldName("function");
  const args = n.childForFieldName("arguments");
  const nameNode = fn?.type === "member_access_expression" ? fn.childForFieldName("name") : fn?.type === "conditional_access_expression" ? fn.namedChildren.find((c) => c.type === "member_binding_expression")?.childForFieldName("name") : fn;
  const name = nameNode?.type === "generic_name" ? nameNode.namedChildren[0]?.text : nameNode?.text;

  if (fn?.type === "identifier" && fn.text === "nameof") {
    const a = args?.namedChildren[0]?.namedChildren.at(-1);
    const e = ir(a, env);
    if (e) intent(ctx, w, source, "references", { e: ["g", e] });
    return;
  }
  // A local function call resolves right here.
  if (fn?.type === "identifier") {
    const v = lookup(env, fn.text);
    if (v && !Array.isArray(v)) {
      emitOnce(ctx, source, { source, relation: "calls", file: ctx.rel, cs: { u: w.u, to: v.lf } });
      if (args) walkArgs(args, ctx, w, env, source, ret);
      return;
    }
  }
  const e = withFirstArg(callIr(n, env, 0), n, env, 0);
  if (e) intent(ctx, w, source, "calls", { e });
  for (const t of genericArgs(nameNode) ?? []) typeRef(ctx, w, source, t);

  // Unity string references (`Resources.Load<T>("x")`, `SetTrigger(Hash)`, …).
  if (name && UNITY_STRING_OPS.has(name) && args) {
    const argVals = args.namedChildren.filter((a) => a.type === "argument").map((a) => strValues(a.namedChildren.at(-1) ?? null, env));
    if (argVals.some((v) => v.some((s) => s.some((p) => p !== null)))) {
      const recv = fn?.type === "member_access_expression" ? ir(fn.childForFieldName("expression"), env) : fn?.type === "conditional_access_expression" ? ir(fn.childForFieldName("condition") ?? fn.namedChildren[0], env) : ["t"] as Expr;
      const ui: Omit<CsUnityIntent, "u" | "ty"> = { op: name, args: argVals };
      if (recv) ui.recv = recv;
      const targs = genericArgs(nameNode);
      if (targs) ui.targ = targs[0];
      unityIntent(ctx, w, source, ui);
    }
    // `action.AddBinding("<Gamepad>/buttonWest")` on an action created in this file
    if ((name === "AddBinding" || name === "With") && fn?.type === "member_access_expression") {
      const recvNode = fn.childForFieldName("expression");
      const recvName = recvNode?.type === "identifier" ? recvNode.text : recvNode?.type === "member_access_expression" ? rootName(recvNode) : null;
      const action = recvName ? ctx.actions.get(recvName) : undefined;
      const binding = stringLiteral(args.namedChildren.filter((a) => a.type === "argument").at(-1)?.namedChildren.at(-1) ?? null);
      if (action && binding) {
        action.signature = `${action.signature ?? ""} | ${binding}`;
        action.body_text = searchBody(`${action.body_text ?? ""} ${binding}`);
        const m = /^L(\d+)-L(\d+)$/.exec(action.span);
        const line = n.endPosition.row + 1;
        if (m && Number(m[1]) <= line && line - Number(m[2]) < 40 && line > Number(m[2])) action.span = `L${m[1]}-L${line}`;
      }
    }
  }
  // `x.onClick.AddListener(Play)` subscribes a handler.
  const isListener = name === "AddListener" || name === "RegisterCallback" || name === "AddCallbacks" || name === "SetCallbacks";

  if (fn?.type === "member_access_expression") {
    const obj = fn.childForFieldName("expression");
    if (obj) {
      const r = ir(obj, env);
      if (r && r[0] !== "i" && r[0] !== "t" && r[0] !== "b") {
        // the receiver chain's members are references too (`run.Player.Tick()` reads Player)
        if (obj.type === "member_access_expression" || obj.type === "conditional_access_expression") intent(ctx, w, source, "references", { e: r });
      } else if (r && r[0] === "i" && lookup(env, (r as ["i", string])[1]) === undefined) {
        intent(ctx, w, source, "references", { e: r });
      }
      walkInnerCalls(obj, ctx, w, env, source, ret);
    }
  } else if (fn?.type === "conditional_access_expression") {
    const cond = fn.childForFieldName("condition") ?? fn.namedChildren[0];
    if (cond) walkBody(cond, ctx, w, env, source, ret);
  }
  if (!args) return;
  if (isListener) {
    for (const a of args.namedChildren) {
      if (a.type !== "argument") continue;
      const v = a.namedChildren.at(-1);
      if (v && isMethodGroup(v, env)) {
        const h = ir(v, env);
        const via = fn?.type === "member_access_expression" ? fn.childForFieldName("expression")?.text.replace(/\s+/g, "") : undefined;
        if (h) intent(ctx, w, source, "subscribes", { e: ["g", h], via });
      } else if (v) walkBody(v, ctx, w, env, source, ret);
    }
    return;
  }
  walkArgs(args, ctx, w, env, source, ret);
}

function rootName(n: TsNode): string | null {
  let cur: TsNode | null = n;
  while (cur?.type === "member_access_expression") {
    const obj: TsNode | null = cur.childForFieldName("expression");
    if (obj?.type === "this" || obj?.text === "this") return cur.childForFieldName("name")?.text.replace(/^@/, "") ?? null;
    cur = obj;
  }
  return cur?.type === "identifier" ? cur.text : null;
}

function unityIntent(ctx: Ctx, w: Where, source: string, ui: Omit<CsUnityIntent, "u" | "ty">): void {
  const payload: CsUnityIntent = { ...ui, u: w.u };
  if (w.typeId) payload.ty = w.typeId;
  emitOnce(ctx, source, { source, relation: "references", file: ctx.rel, unity: payload });
}

/**
 * `new InputAction("Melee", InputActionType.Button, "<Keyboard>/f")` — an Input
 * System action defined in code rather than in an `.inputactions` asset. It gets
 * its own node (kind `action`) so "which action triggers PlayerMelee" has an
 * answer in the graph; later `AddBinding` calls on the same variable append their
 * paths to its signature.
 */
function maybeInputAction(creation: TsNode, ctx: Ctx, w: Where, varName: string): void {
  const t = typeText(creation.childForFieldName("type"));
  if (t !== "InputAction" && t !== "UnityEngine.InputSystem.InputAction") return;
  const args = creation.childForFieldName("arguments")?.namedChildren.filter((a) => a.type === "argument") ?? [];
  const named = (label: string) => args.find((a) => a.childForFieldName("name")?.text.replace(/^@/, "") === label)?.namedChildren.at(-1) ?? null;
  const actionName = stringLiteral(named("name") ?? args[0]?.namedChildren.at(-1) ?? null);
  if (!actionName) return;
  const typeArg = (named("type") ?? args[1]?.namedChildren.at(-1))?.text.replace(/^InputActionType\./, "");
  const binding = stringLiteral(named("binding") ?? args.find((a, i) => i >= 1 && stringLiteral(a.namedChildren.at(-1) ?? null) !== null)?.namedChildren.at(-1) ?? null);
  const stmt = creation.parent?.type === "assignment_expression" || creation.parent?.type === "variable_declarator" ? creation.parent : creation;
  const id = pushNode(ctx, { ...w, parentId: w.memberId ?? w.parentId }, stmt, actionName, "action", stmt.endIndex, {
    owner: w.typeName,
    signature: `InputAction "${actionName}"${typeArg && !/^"/.test(typeArg) ? ` (${typeArg})` : ""}${binding ? ` | ${binding}` : ""} → ${varName}`,
  }, `${varName}:${actionName}`);
  const node = ctx.nodes[ctx.nodes.length - 1];
  node.body_text = searchBody(`${node.signature} ${stmt.text}`);
  ctx.actions.set(varName, node);
  // the class defining the action uses it
  if (w.memberId && w.memberId !== id) emitOnce(ctx, w.memberId, { source: w.memberId, relation: "references", file: ctx.rel, targetId: id });
}
