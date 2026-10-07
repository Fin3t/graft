/**
 * `graph.json` — the code graph schema (v1).
 *
 * One node per definition (file, class, function, method, interface, type, enum),
 * wired by edges (contains, imports, calls, ...). Field names follow the LSP
 * vocabulary (`name`, `kind`, ...) rather than any one tool's conventions.
 *
 * Two tiers of data live on a node:
 *   - Tier-1 (deterministic, $0): everything from the AST. Rebuilt on every run.
 *   - Tier-2 (one LLM call, cached on `body_hash`): `summary` + `crux`.
 * M1 populates Tier-1 only; Tier-2 fields ship as `pending`/null.
 */

/** What a node represents. LSP SymbolKind, narrowed to what our extractors produce. */
export type Kind =
  | "file"
  | "class"
  | "function"
  | "method"
  | "interface" // TS + Go
  | "type" // TS + Go (type alias / named type)
  | "enum" // TS + PHP + Java
  | "struct" // Go only
  | "trait" // PHP only
  // The generic (tags.scm) breadth tier also emits these — every tree-sitter
  // grammar's tags.scm uses the tree-sitter tags @definition.<X> vocabulary, and
  // module/constant/variable are common across the long tail (Ruby modules,
  // Rust consts, top-level lets, …). Kept distinct rather than coerced so the
  // breadth tier's kinds read truthfully in cards/skeleton.
  | "module"
  | "constant"
  | "variable"
  // C# members (the C# depth tier, csharp.ts): a property/indexer, a field and an
  // event are first-class definitions there — Unity serializes fields and wires
  // events — so they get their own kinds rather than collapsing into "variable".
  | "property"
  | "field"
  | "event"
  // Unity layer (unity.ts): a script/Animator component on a GameObject in a scene/prefab, an asset known only
  // through its `.meta` (texture, mesh, audio, folder), an Animator state or
  // parameter, an Input System action, and a tag/layer from TagManager.asset.
  | "component"
  | "asset"
  | "state"
  | "parameter"
  | "action"
  | "tag"
  | "layer";

/** How confident we are an edge is true, best-first. The hand-written AST
 * resolver assigns `extracted`/`inferred`; the opt-in LSP enrichment pass
 * (`graft build --lsp`) can promote an edge to compiler-grade `lsp_resolved`
 * (an exact server-confirmed target) or `lsp_dispatch` (an interface/virtual
 * candidate). Order matters: consumers that rank by provenance treat earlier
 * values as stronger. */
export type Confidence = "lsp_resolved" | "lsp_dispatch" | "extracted" | "inferred";

/** Whether the LLM meaning-layer has been computed for a node. */
export type SummaryState = "pending" | "ready" | "stale";

/** The LLM-chosen business-logic excerpt. `code` is the source of truth; `span`
 * is a best-effort pointer that may drift and is never used to re-slice. */
export interface Crux {
  code: string;
  span: string; // e.g. "L189-L196"
}

export interface NodeV1 {
  // identity
  id: string; // path-scoped: "src/cache.ts#Cache.get"
  name: string; // the symbol's own name: "get"
  kind: Kind;
  // method nodes only: the bare name of the immediate enclosing class/receiver
  // ("Cache" for "get"). Lets owner-qualified lookups (resolve.ts's ownerMethod
  // index) key off a stored field instead of re-deriving it by slicing `id`,
  // which breaks once ids can carry a dedup ordinal (`Cache.get~2`).
  owner?: string;

  // location (Tier-1, deterministic)
  path: string; // repo-relative: "src/cache.ts"
  span: string; // whole definition: "L165-L222"
  signature: string | null; // "get(k: string): number" — null for kind:"file"
  exported: boolean;
  // How the node was extracted. "ast" = a first-class hand-written extractor
  // (TS/JS/Python/Go, full-fidelity). "generic" = the tags.scm breadth tier
  // (signature-only; symbols + bare edges, no scope-aware binding).
  origin: "ast" | "generic";
  body_hash: string; // sha256 of the definition text; the Tier-2 re-run trigger
  chars?: number; // byte length of the WHOLE file (file nodes only); the baseline
  //                 `ask` uses to estimate tokens saved vs reading the file whole
  body_text?: string; // searchable whitespace-normalized definition body (Tier-1,
  //                 symbol nodes only, capped). Ranks `ask` queries so a term in
  //                 the code — not just the name/signature — is findable; never
  //                 emitted to the agent (that reads verbatim source via `--source`).
  //                 Absent on file nodes and on graphs built before this field.
  arity?: number; // declared parameter count (method/constructor nodes). Disambiguates
  //                 OVERLOADS, which only Java has among the languages parsed here: two
  //                 same-named methods on one class are otherwise separable only by
  //                 arity, and picking the wrong one turns a delegating overload into a
  //                 self-loop. Absent on graphs built before this field, and on
  //                 languages that do not emit it — resolution then behaves as before.
  variadic?: boolean; // the last parameter is a vararg (`String... xs`), so the declared
  //                 arity is a MINIMUM, not an equality. Never arity-filtered out.
  entry?: string; // called by an engine/framework rather than by code in the repo: a
  //                 Unity message (`Update`), an `[InitializeOnLoad]`/`[MenuItem]`
  //                 target, an `-executeMethod` target, a test. Set by the resolver,
  //                 so "no indexed callers" is not mistaken for dead code.
  pkg?: string; // third-party code vendored into the repo (a Unity embedded package
  //                 under `Packages/<name>/`): the package name. Indexed, but labelled
  //                 foreign so it never reads as the project's own code.

  // meaning (Tier-2, one LLM call)
  summary_state: SummaryState;
  summary: string | null;
  crux: Crux | null;
}

export type Relation =
  | "contains" // file → symbol, class → method (structural)
  | "calls" // function → function it invokes
  | "imports" // file → module
  | "references" // symbol → symbol it names but doesn't call
  | "implements" // TS: class → interface
  | "extends" // class → base class
  | "overrides" // C#: method → the base/interface member it overrides or implements
  | "subscribes" // C#: method → handler it subscribes (`x.Evt += H`, `AddListener(H)`)
  // Unity layer — asset wiring that is not code but decides what code runs.
  | "attaches" // GameObject → MonoBehaviour class it carries (m_Script)
  | "nests" // GameObject → prefab it instantiates (PrefabInstance.m_SourcePrefab)
  | "variant_of" // prefab variant → its base prefab
  | "instance_of" // ScriptableObject asset → its class
  | "assigns" // serialized field → the asset/object it points to (via = field)
  | "invokes" // UnityEvent / AnimationEvent / input action / SendMessage → method
  | "loads" // code → asset named by a string (Resources.Load, Shader.Find, LoadScene, …)
  | "sets" // code → Animator parameter, shader property, tag or layer named by a string
  | "plays" // code → Animator state named by a string (Play/CrossFade)
  | "uses_shader" // material → shader / shader graph
  | "compiles"; // assembly definition (.asmdef) → a C# file it compiles

export interface EdgeV1 {
  source: string; // node id
  target: string; // node id, or an unresolved module string for imports
  relation: Relation;
  confidence: Confidence;
  /** What carries the edge, when the relation alone does not say: the serialized
   * field (`assigns`, `invokes`), the event expression (`subscribes`), the string
   * that named the target (`loads`, `sets`). Display only — never part of identity. */
  via?: string;
}

/** A ranking scope: a sub-project discovered by project-marker files (`package.json`,
 * `go.mod`, ...). `prefix` is a posix path relative to the graph root ("" = root scope);
 * `label` is the same value without a trailing slash (also "" for root); `markers` lists
 * which marker file(s) were found in that directory. See `src/graph/scopes.ts`. */
export interface ScopeV1 {
  prefix: string;
  label: string;
  markers: string[];
}

export interface GraphV1 {
  meta: {
    version: 1;
    nodeCount: number;
    edgeCount: number;
    languages: string[];
    /** Ranking scopes: posix path prefixes relative to the graph root, "" = root scope.
     * Absent (old graphs) ≡ [{ prefix: "", label: "" }]. Sorted by prefix length desc. */
    scopes?: ScopeV1[];
  };
  nodes: NodeV1[];
  edges: EdgeV1[];
}
