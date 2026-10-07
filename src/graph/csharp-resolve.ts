/**
 * C# resolution: facts + intents from csharp.ts → edges.
 *
 * Builds one type index for the whole repo — partial classes merged across
 * files, nested types under their outer type, generic arity part of a type's
 * identity — and resolves names the way the C# compiler looks them up, reduced
 * to what an index needs:
 *
 *   - type names: type parameters → nested types of the enclosing types (and
 *     their bases) → each enclosing namespace, innermost first, with the `using`
 *     directives and aliases declared at that level → `global using`s;
 *   - simple names in a body: members of the enclosing types (inherited ones
 *     included) → types/namespaces → `using static` members;
 *   - member access: instance or static member of the receiver's static type,
 *     walking base classes and interfaces, then extension methods.
 *
 * External types (BCL, UnityEngine/UnityEditor, packages) come from cs-api.ts and
 * are named by their fully-qualified name when an edge must point at them
 * (heritage, overrides). Anything that cannot be resolved precisely is dropped —
 * the same contract resolve.ts keeps for every other language.
 */
import type { EdgeV1, Kind, NodeV1, Relation } from "./types.js";
import type { RawEdge } from "./extract.js";
import { PREDEFINED, type CsFacts, type CsMemberFact, type CsScope, type CsTypeFact, type Expr } from "./csharp.js";
import { apiData, type ApiData, type ApiMember, type ApiType } from "./cs-api.js";

// ── Type syntax ─────────────────────────────────────────────────────────────

export interface TypeSyntax {
  parts: Array<{ n: string; args: TypeSyntax[] }>; // `A.B<C>.D`
  arr: number; // array rank count (`T[][]` = 2)
  tuple?: TypeSyntax[];
}

/** Parse normalised type text (csharp.ts `typeText`). Null on garbage. */
export function parseType(text: string): TypeSyntax | null {
  let i = 0;
  const s = text.replace(/global::/g, "");
  const ident = (): string | null => {
    const m = /^[@A-Za-z_!][A-Za-z0-9_!]*/.exec(s.slice(i));
    if (!m) return null;
    i += m[0].length;
    return m[0].replace(/^@/, "");
  };
  const type = (): TypeSyntax | null => {
    let t: TypeSyntax;
    if (s[i] === "(") {
      i++;
      const els: TypeSyntax[] = [];
      while (i < s.length && s[i] !== ")") {
        const el = type();
        if (!el) return null;
        els.push(el);
        // tuple element names were dropped by typeText; skip any stray name
        while (s[i] && s[i] !== "," && s[i] !== ")") i++;
        if (s[i] === ",") i++;
      }
      i++;
      t = { parts: [{ n: "ValueTuple", args: els }], arr: 0, tuple: els };
    } else {
      const parts: TypeSyntax["parts"] = [];
      for (;;) {
        const n = ident();
        if (!n) return null;
        const args: TypeSyntax[] = [];
        if (s[i] === "<") {
          i++;
          while (i < s.length && s[i] !== ">") {
            if (s[i] === ",") {
              i++;
              continue;
            }
            const a = type();
            if (!a) {
              // open generic `typeof(List<>)`
              if (s[i] === "," || s[i] === ">") {
                args.push({ parts: [{ n: "?", args: [] }], arr: 0 });
                continue;
              }
              return null;
            }
            args.push(a);
          }
          i++;
        }
        parts.push({ n, args });
        if (s[i] === "." || (s[i] === ":" && s[i + 1] === ":")) {
          i += s[i] === "." ? 1 : 2;
          continue;
        }
        break;
      }
      t = { parts, arr: 0 };
    }
    for (;;) {
      if (s[i] === "?" || s[i] === "*") {
        i++;
        continue;
      }
      if (s[i] === "[") {
        while (i < s.length && s[i] !== "]") i++;
        i++;
        t.arr++;
        continue;
      }
      break;
    }
    return t;
  };
  const out = type();
  return out;
}

// ── Model ───────────────────────────────────────────────────────────────────

export interface TypeInfo {
  key: string; // "Ns.Outer+Name`1"
  name: string;
  arity: number;
  kind: Kind;
  ns: string;
  outer: TypeInfo | null;
  facts: CsTypeFact[]; // one per partial declaration
  ids: string[]; // node ids of the declarations
  id: string; // primary node id (first declaration in path order)
  files: string[];
  members: Map<string, MemberInfo[]>;
  nested: Map<string, TypeInfo[]>; // simple name → nested types
  tparams: string[];
  /** Resolved bases (lazily). */
  bases?: TypeValue[];
  static: boolean;
}

export interface MemberInfo {
  fact: CsMemberFact;
  owner: TypeInfo;
  file: string;
}

/** A static type. */
export type TypeValue =
  | { k: "in"; t: TypeInfo; args: TypeValue[] }
  | { k: "ex"; fqn: string; args: TypeValue[]; api?: ApiType }
  | { k: "arr"; el: TypeValue }
  | { k: "tp"; name: string; bounds: TypeValue[] };

/** What a name/expression resolved to. */
type Sym =
  | { k: "val"; tv: TypeValue | null; member?: MemberInfo; ext?: string } // a value of some type
  | { k: "type"; tv: TypeValue } // a type used as a receiver (static access)
  | { k: "ns"; ns: string } // a namespace prefix
  | { k: "group"; members: MemberInfo[]; ext?: string[]; recv: TypeValue | null; isStatic: boolean } // method group
  | null;

interface Scope {
  file: string;
  facts: CsFacts;
  u: number;
  type: TypeInfo | null; // innermost enclosing type
  method?: MemberInfo; // enclosing member (method generic params)
}

const COLLECTION_1 = new Set(
  [
    "System.Collections.Generic.List`1", "System.Collections.Generic.IList`1", "System.Collections.Generic.IReadOnlyList`1",
    "System.Collections.Generic.ICollection`1", "System.Collections.Generic.IReadOnlyCollection`1",
    "System.Collections.Generic.IEnumerable`1", "System.Collections.Generic.HashSet`1", "System.Collections.Generic.ISet`1",
    "System.Collections.Generic.Queue`1", "System.Collections.Generic.Stack`1", "System.Collections.Generic.LinkedList`1",
    "System.Collections.Generic.SortedSet`1", "System.Collections.ObjectModel.ReadOnlyCollection`1",
    "System.Collections.ObjectModel.ObservableCollection`1", "System.Collections.Concurrent.ConcurrentQueue`1",
    "System.Collections.Concurrent.ConcurrentBag`1", "System.Collections.Concurrent.ConcurrentStack`1",
    "System.Collections.Generic.IEnumerator`1", "System.Span`1", "System.ReadOnlySpan`1", "System.ArraySegment`1",
    "Unity.Collections.NativeArray`1", "Unity.Collections.NativeList`1", "System.Collections.Generic.IAsyncEnumerable`1",
    "System.Linq.IOrderedEnumerable`1", "System.Linq.IGrouping`2",
  ].map((k) => k),
);
const DICTIONARY_2 = new Set([
  "System.Collections.Generic.Dictionary`2", "System.Collections.Generic.IDictionary`2",
  "System.Collections.Generic.IReadOnlyDictionary`2", "System.Collections.Generic.SortedDictionary`2",
  "System.Collections.Generic.SortedList`2", "System.Collections.Concurrent.ConcurrentDictionary`2",
]);
const ENUMERABLE = "System.Collections.Generic.IEnumerable`1";
/** LINQ/collection methods returning one element of the receiver. */
const ELEMENT_OF = new Set([
  "First", "FirstOrDefault", "Last", "LastOrDefault", "Single", "SingleOrDefault", "ElementAt", "ElementAtOrDefault",
  "Min", "Max", "MinBy", "MaxBy", "Find", "FindLast", "Dequeue", "Peek", "Pop", "Aggregate", "Random", "PickRandom",
]);
/** LINQ/collection methods returning a sequence of the receiver's elements. */
const SEQUENCE_OF = new Set([
  "Where", "OrderBy", "OrderByDescending", "ThenBy", "ThenByDescending", "Skip", "SkipWhile", "SkipLast", "Take",
  "TakeWhile", "TakeLast", "Distinct", "DistinctBy", "Reverse", "Concat", "Union", "Except", "Intersect", "AsEnumerable",
  "ToList", "ToArray", "FindAll", "GetRange", "ToHashSet", "Append", "Prepend", "Shuffle", "AsReadOnly",
]);
/** Generic Unity/BCL methods whose result is their (first) type argument even when the
 * API data is missing for the receiver. */
const RETURNS_TARG = new Set([
  "GetComponent", "GetComponentInChildren", "GetComponentInParent", "AddComponent", "FindObjectOfType",
  "FindAnyObjectByType", "FindFirstObjectByType", "Load", "LoadAssetAtPath", "CreateInstance", "FromJson",
  "Instantiate", "GetOrAddComponent", "EnsureComponent", "Get", "OfType", "Cast",
]);
const RETURNS_TARG_ARRAY = new Set([
  "GetComponents", "GetComponentsInChildren", "GetComponentsInParent", "FindObjectsOfType", "FindObjectsByType", "LoadAll",
]);

export interface CsModel {
  types: TypeInfo[];
  byId: Map<string, TypeInfo>; // any declaration node id → type
  memberById: Map<string, MemberInfo>;
  api: ApiData;
  /** Does `t` derive (transitively) from the external type `fqn`? */
  derivesFrom(t: TypeInfo, fqn: string): boolean;
  /** Every type in the repo whose simple name is `name`. */
  typesNamed(name: string): TypeInfo[];
  /** Base chain of a type, nearest first (in-repo and external). */
  baseChain(t: TypeInfo): TypeValue[];
  /** Resolve `text` as a type in the context of file/scope. */
  resolveTypeIn(file: string, u: number, typeId: string | undefined, text: string): TypeValue | null;
  /** Instance + inherited members named `name` of a type. */
  membersOf(t: TypeInfo, name: string): MemberInfo[];
  /** Type value of an expression (from a C# or Unity intent). */
  typeOf(file: string, u: number, typeId: string | undefined, sourceId: string, e: Expr): TypeValue | null;
  /** The member a reference expression names (`PlaygroundDirector.SceneName`). */
  memberOf(file: string, u: number, typeId: string | undefined, sourceId: string, e: Expr): MemberInfo | null;
  /** Possible string values of a constant reference, when statically known. */
  constValues(file: string, u: number, typeId: string | undefined, sourceId: string, e: Expr): { values: string[]; hash?: "anim" | "prop" } | null;
  fqnOf(tv: TypeValue): string;
}

export interface CsResolveResult {
  edges: EdgeV1[];
  model: CsModel;
}

function apiKey(fqn: string, arity: number): string {
  return arity ? `${fqn}\`${arity}` : fqn;
}

/** Strip a `\`n` arity suffix. */
function bareKey(key: string): string {
  return key.replace(/`\d+$/, "");
}

export function resolveCSharp(
  nodes: NodeV1[],
  rawEdges: RawEdge[],
  factsByFile: Map<string, CsFacts>,
  api: ApiData = apiData(),
): CsResolveResult {
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  // ── index types ──
  const byKey = new Map<string, TypeInfo>();
  const byId = new Map<string, TypeInfo>();
  const byNs = new Map<string, Map<string, TypeInfo[]>>(); // ns → simple name → top-level types
  const namespaces = new Set<string>([""]);
  const typesByName = new Map<string, TypeInfo[]>();
  const files = [...factsByFile.keys()].sort();
  const keyOf = new Map<string, string>(); // type fact id → key
  for (const file of files) {
    const facts = factsByFile.get(file)!;
    for (const tf of facts.types) {
      const outerKey = tf.outer ? keyOf.get(tf.outer) : undefined;
      const key = outerKey ? `${outerKey}+${apiKey(tf.name, tf.arity)}` : apiKey(tf.ns ? `${tf.ns}.${tf.name}` : tf.name, tf.arity);
      keyOf.set(tf.id, key);
      let t = byKey.get(key);
      if (!t) {
        t = {
          key,
          name: tf.name,
          arity: tf.arity,
          kind: tf.kind,
          ns: tf.ns,
          outer: outerKey ? (byKey.get(outerKey) ?? null) : null,
          facts: [],
          ids: [],
          id: tf.id,
          files: [],
          members: new Map(),
          nested: new Map(),
          tparams: tf.tparams ?? [],
          static: !!tf.static,
        };
        byKey.set(key, t);
        push(typesByName, tf.name, t);
        if (t.outer) push(t.outer.nested, tf.name, t);
        else {
          let m = byNs.get(tf.ns);
          if (!m) byNs.set(tf.ns, (m = new Map()));
          push(m, tf.name, t);
          let ns = tf.ns;
          while (ns) {
            namespaces.add(ns);
            ns = ns.includes(".") ? ns.slice(0, ns.lastIndexOf(".")) : "";
          }
        }
      }
      t.facts.push(tf);
      t.ids.push(tf.id);
      if (!t.files.includes(file)) t.files.push(file);
      if (tf.static) t.static = true;
      byId.set(tf.id, t);
    }
  }
  const memberById = new Map<string, MemberInfo>();
  const extensions = new Map<string, MemberInfo[]>(); // method name → extension methods
  for (const file of files) {
    for (const mf of factsByFile.get(file)!.members) {
      const owner = byId.get(mf.owner);
      if (!owner) continue;
      const mi: MemberInfo = { fact: mf, owner, file };
      if (mf.mk !== "local") push(owner.members, mf.name, mi);
      if (mf.id) memberById.set(mf.id, mi);
      if (mf.ext) push(extensions, mf.name, mi);
    }
  }
  // External namespaces (for `using` lookups and qualified names).
  const apiNamespaces = new Set<string>();
  for (const k of Object.keys(api.types)) {
    let ns = bareKey(k);
    ns = ns.includes(".") ? ns.slice(0, ns.lastIndexOf(".")) : "";
    while (ns) {
      apiNamespaces.add(ns);
      ns = ns.includes(".") ? ns.slice(0, ns.lastIndexOf(".")) : "";
    }
  }
  const globalUsings: string[] = [];
  const globalStatics: string[] = [];
  for (const f of files) {
    const facts = factsByFile.get(f)!;
    globalUsings.push(...(facts.globalUsings ?? []));
    globalStatics.push(...(facts.globalStatics ?? []));
  }

  // ── type lookup ──
  const typeCache = new Map<string, TypeValue | null>();

  const exType = (fqn: string, args: TypeValue[]): TypeValue | null => {
    const key = apiKey(fqn, args.length);
    const api1 = api.types[key];
    if (!api1) return null;
    return { k: "ex", fqn: key, args, api: api1 };
  };

  /** Top-level lookup of `name`/arity in namespace `ns` (in-repo first, then API). */
  const inNamespace = (ns: string, name: string, arity: number, args: TypeValue[]): TypeValue | "ambiguous" | null => {
    const hits = (byNs.get(ns)?.get(name) ?? []).filter((t) => t.arity === arity);
    if (hits.length === 1) return { k: "in", t: hits[0], args };
    if (hits.length > 1) return "ambiguous";
    return exType(ns ? `${ns}.${name}` : name, args);
  };

  /** Nested type `name` in a type value (and its bases). */
  const nestedIn = (tv: TypeValue, name: string, arity: number, args: TypeValue[]): TypeValue | null => {
    if (tv.k === "in") {
      const seen = new Set<TypeInfo>();
      const walk = (t: TypeInfo): TypeValue | null => {
        if (seen.has(t)) return null;
        seen.add(t);
        const hit = (t.nested.get(name) ?? []).find((x) => x.arity === arity);
        if (hit) return { k: "in", t: hit, args };
        for (const b of basesOf(t)) {
          if (b.k === "in") {
            const r = walk(b.t);
            if (r) return r;
          } else if (b.k === "ex") {
            const r = exType(`${bareKey(b.fqn)}.${name}`, args);
            if (r) return r;
          }
        }
        return null;
      };
      return walk(tv.t);
    }
    if (tv.k === "ex") return exType(`${bareKey(tv.fqn)}.${name}`, args);
    return null;
  };

  const scopeChain = (facts: CsFacts, u: number): CsScope[] => {
    const out: CsScope[] = [];
    for (let i = u; i >= 0; i = facts.scopes[i].parent) {
      out.push(facts.scopes[i]);
      if (facts.scopes[i].parent === i) break;
    }
    return out;
  };

  const typeParamValue = (sc: Scope, name: string): TypeValue | null => {
    const mf = sc.method?.fact;
    const cons = (c: Record<string, string[]> | undefined) => c?.[name] ?? [];
    if (mf?.tparams?.includes(name)) {
      const bounds = cons(mf.constraints).map((b) => resolveTypeText(sc, b, 1)).filter((x): x is TypeValue => !!x);
      return { k: "tp", name, bounds };
    }
    for (let t = sc.type; t; t = t.outer) {
      if (t.tparams.includes(name)) {
        const bounds: TypeValue[] = [];
        for (const f of t.facts) for (const b of cons(f.constraints)) {
          const r = resolveTypeText(sc, b, 1);
          if (r) bounds.push(r);
        }
        return { k: "tp", name, bounds };
      }
    }
    return null;
  };

  /** Resolve the first segment of a type name, or a namespace. */
  const lookupTypeName = (sc: Scope, name: string, arity: number, args: TypeValue[]): TypeValue | { ns: string } | null => {
    if (arity === 0) {
      const tp = typeParamValue(sc, name);
      if (tp) return tp;
    }
    // nested types of enclosing types (and their bases)
    for (let t = sc.type; t; t = t.outer) {
      const r = nestedIn({ k: "in", t, args: [] }, name, arity, args);
      if (r) return r;
    }
    const chain = scopeChain(sc.facts, sc.u);
    for (let i = 0; i < chain.length; i++) {
      const scope = chain[i];
      const stop = chain[i + 1]?.ns ?? null;
      // namespaces declared by this scope, innermost first (`A.B.C` → A.B.C, A.B, A)
      let ns = scope.ns;
      for (;;) {
        const r = inNamespace(ns, name, arity, args);
        if (r === "ambiguous") return null;
        if (r) return r;
        if (arity === 0) {
          const sub = ns ? `${ns}.${name}` : name;
          if (namespaces.has(sub) || apiNamespaces.has(sub)) return { ns: sub };
        }
        if (!ns || ns === stop) break;
        ns = ns.includes(".") ? ns.slice(0, ns.lastIndexOf(".")) : "";
        if (stop !== null && ns.length < stop.length) break;
      }
      // aliases and using namespaces declared at this level
      for (const [alias, target] of scope.aliases) {
        if (alias === name && arity === 0) {
          const r = resolveTypeText({ ...sc, u: scope.parent >= 0 ? scope.parent : 0 }, target, 1);
          if (r) return r;
          if (namespaces.has(target) || apiNamespaces.has(target)) return { ns: target };
        }
      }
      const usings = i === chain.length - 1 ? [...scope.usings, ...globalUsings] : scope.usings;
      let found: TypeValue | null = null;
      let count = 0;
      for (const u of usings) {
        const r = inNamespace(u, name, arity, args);
        if (r === "ambiguous") return null;
        if (r && !(found && sameType(found, r))) {
          found = r;
          count++;
        }
      }
      if (count === 1) return found;
      if (count > 1) return null; // ambiguous between usings
      // `using static T;` also imports T's nested types
      const statics = i === chain.length - 1 ? [...scope.statics, ...globalStatics] : scope.statics;
      for (const st of statics) {
        const owner = resolveTypeText({ ...sc, u: scope.parent >= 0 ? scope.parent : 0, type: null }, st, 1);
        const r = owner ? nestedIn(owner, name, arity, args) : null;
        if (r) return r;
      }
    }
    if (arity === 0 && apiNamespaces.has(name)) return { ns: name };
    return null;
  };

  function resolveTypeText(sc: Scope, text: string, depth = 0): TypeValue | null {
    if (depth > 6) return null;
    const cacheKey = `${sc.file}|${sc.u}|${sc.type?.key ?? ""}|${sc.method?.fact.id ?? ""}|${text}`;
    if (typeCache.has(cacheKey)) return typeCache.get(cacheKey)!;
    typeCache.set(cacheKey, null); // cycle guard
    const syn = parseType(text);
    const r = syn ? resolveSyntax(sc, syn, depth) : null;
    typeCache.set(cacheKey, r);
    return r;
  }

  function resolveSyntax(sc: Scope, syn: TypeSyntax, depth: number): TypeValue | null {
    let tv: TypeValue | null = null;
    if (syn.tuple) {
      const els = syn.tuple.map((t) => resolveSyntax(sc, t, depth + 1) ?? ({ k: "ex", fqn: "?", args: [] } as TypeValue));
      tv = { k: "ex", fqn: `System.ValueTuple\`${syn.tuple.length}`, args: els };
    } else {
      const first = syn.parts[0];
      const pre = syn.parts.length === 1 && first.args.length === 0 ? PREDEFINED[first.n] : undefined;
      if (pre) tv = exType(pre, []) ?? { k: "ex", fqn: pre, args: [] };
      else if (/^!!\d+$/.test(first.n)) return null;
      else {
        const argsOf = (p: { args: TypeSyntax[] }) =>
          p.args.map((a) => resolveSyntax(sc, a, depth + 1) ?? ({ k: "ex", fqn: "?", args: [] } as TypeValue));
        let cur: TypeValue | { ns: string } | null = lookupTypeName(sc, first.n, first.args.length, argsOf(first));
        for (let i = 1; i < syn.parts.length && cur; i++) {
          const p = syn.parts[i];
          const args = argsOf(p);
          if ("ns" in cur) {
            const ns: string = cur.ns;
            const r = inNamespace(ns, p.n, p.args.length, args);
            if (r === "ambiguous") return null;
            if (r) cur = r;
            else if (p.args.length === 0 && (namespaces.has(`${ns}.${p.n}`) || apiNamespaces.has(`${ns}.${p.n}`))) cur = { ns: `${ns}.${p.n}` };
            else cur = null;
          } else cur = nestedIn(cur, p.n, p.args.length, args);
        }
        if (!cur || "ns" in cur) return null;
        tv = cur;
      }
    }
    for (let i = 0; i < syn.arr; i++) tv = { k: "arr", el: tv! };
    return tv;
  }

  // ── bases ──
  function scopeFor(t: TypeInfo, fi = 0): Scope {
    const f = t.facts[fi];
    const file = t.files.find((x) => factsByFile.get(x)!.types.includes(f)) ?? t.files[0];
    return { file, facts: factsByFile.get(file)!, u: f.u, type: t.outer ?? t };
  }

  function basesOf(t: TypeInfo): TypeValue[] {
    if (t.bases) return t.bases;
    t.bases = [];
    const out: TypeValue[] = [];
    t.facts.forEach((f, fi) => {
      // A base list resolves in the scope enclosing the declaration, but may name the
      // type's own type parameters.
      const sc: Scope = { ...scopeFor(t, fi), type: t };
      for (const b of f.bases) {
        const r = resolveTypeText(sc, b);
        if (r && !out.some((x) => sameType(x, r)) && !(r.k === "in" && r.t === t)) out.push(r);
      }
    });
    if (t.kind === "enum") out.push({ k: "ex", fqn: "System.Enum", args: [] });
    t.bases = out;
    return out;
  }

  const apiBases = (tv: TypeValue & { k: "ex" }): TypeValue[] => {
    const a = tv.api ?? api.types[tv.fqn];
    if (!a) return [];
    const out: TypeValue[] = [];
    const sub = genericMap(a.g ?? [], tv.args);
    for (const b of [a.b, ...(a.i ?? [])]) {
      if (!b) continue;
      const r = resolveApiType(b, sub);
      if (r) out.push(r);
    }
    return out;
  };

  /** Resolve a type text from the API data (fully-qualified), substituting generic params. */
  function resolveApiType(text: string, sub: Map<string, TypeValue>, targs: TypeValue[] = []): TypeValue | null {
    const syn = parseType(text);
    if (!syn) return null;
    const conv = (s: TypeSyntax): TypeValue | null => {
      let tv: TypeValue | null;
      if (s.tuple) tv = { k: "ex", fqn: `System.ValueTuple\`${s.tuple.length}`, args: [] };
      else {
        const p0 = s.parts[0];
        if (s.parts.length === 1 && p0.args.length === 0 && sub.has(p0.n)) tv = sub.get(p0.n)!;
        else if (s.parts.length === 1 && /^!!\d+$/.test(p0.n)) tv = targs[Number(p0.n.slice(2))] ?? null;
        else if (s.parts.length === 1 && PREDEFINED[p0.n]) tv = { k: "ex", fqn: PREDEFINED[p0.n], args: [] };
        else {
          const args = s.parts.flatMap((p) => p.args).map((a) => conv(a) ?? ({ k: "ex", fqn: "?", args: [] } as TypeValue));
          const fqn = s.parts.map((p) => p.n).join(".");
          const key = apiKey(fqn, args.length);
          // A repo type can also appear in API text (never in generated data, but cheap).
          const inRepo = byKey.get(key);
          tv = inRepo ? { k: "in", t: inRepo, args } : { k: "ex", fqn: key, args, api: api.types[key] };
        }
      }
      for (let i = 0; tv && i < s.arr; i++) tv = { k: "arr", el: tv };
      return tv;
    };
    return conv(syn);
  }

  function genericMap(names: string[], args: TypeValue[]): Map<string, TypeValue> {
    const m = new Map<string, TypeValue>();
    names.forEach((n, i) => {
      if (args[i]) m.set(n, args[i]);
    });
    return m;
  }

  /** Base types of any type value. */
  function directBases(tv: TypeValue): TypeValue[] {
    if (tv.k === "in") {
      const sub = genericMap(tv.t.tparams, tv.args);
      return basesOf(tv.t).map((b) => substitute(b, sub));
    }
    if (tv.k === "ex") return apiBases(tv);
    if (tv.k === "tp") return tv.bounds;
    if (tv.k === "arr") return [{ k: "ex", fqn: "System.Array", args: [] }];
    return [];
  }

  function substitute(tv: TypeValue, sub: Map<string, TypeValue>): TypeValue {
    if (!sub.size) return tv;
    if (tv.k === "tp") return sub.get(tv.name) ?? tv;
    if (tv.k === "arr") return { k: "arr", el: substitute(tv.el, sub) };
    if (tv.k === "in" || tv.k === "ex") return { ...tv, args: tv.args.map((a) => substitute(a, sub)) };
    return tv;
  }

  function sameType(a: TypeValue, b: TypeValue): boolean {
    if (a.k !== b.k) return false;
    if (a.k === "in" && b.k === "in") return a.t === b.t;
    if (a.k === "ex" && b.k === "ex") return a.fqn === b.fqn;
    if (a.k === "arr" && b.k === "arr") return sameType(a.el, b.el);
    if (a.k === "tp" && b.k === "tp") return a.name === b.name;
    return false;
  }

  function fqnOf(tv: TypeValue): string {
    if (tv.k === "in") return tv.t.key.replace(/\+/g, ".").replace(/`\d+/g, "");
    if (tv.k === "ex") return bareKey(tv.fqn).replace(/`\d+/g, "");
    if (tv.k === "arr") return `${fqnOf(tv.el)}[]`;
    return tv.name;
  }

  // ── members ──
  interface Found {
    members: MemberInfo[];
    api?: { m: ApiMember; owner: TypeValue & { k: "ex" }; name: string };
    via: TypeValue; // the type the member was found on (generic substitution source)
  }

  /** Find member `name` on a type value: own, then base chain (BFS, cycle-safe). */
  function findMember(tv: TypeValue, name: string): Found | null {
    const seen = new Set<string>();
    let frontier: TypeValue[] = [tv];
    for (let depth = 0; depth < 12 && frontier.length; depth++) {
      const next: TypeValue[] = [];
      for (const cur of frontier) {
        const k = cur.k === "in" ? `in:${cur.t.key}` : cur.k === "ex" ? `ex:${cur.fqn}` : cur.k === "tp" ? `tp:${cur.name}` : "arr";
        if (seen.has(k)) continue;
        seen.add(k);
        if (cur.k === "in") {
          const ms = cur.t.members.get(name);
          if (ms?.length) return { members: ms, via: cur };
        } else if (cur.k === "ex") {
          const a = cur.api ?? api.types[cur.fqn];
          const m = a?.m?.[name];
          if (m) return { members: [], api: { m, owner: { ...cur, api: a }, name }, via: cur };
        }
        next.push(...directBases(cur));
      }
      frontier = next;
    }
    return null;
  }

  /** Type of a member's value (field/property/event type, method return type),
   * with generic parameters of its declaring type bound from `via`. */
  function memberType(mi: MemberInfo, via: TypeValue | null, targs: TypeValue[]): TypeValue | null {
    const text = mi.fact.mk === "ctor" ? null : mi.fact.type;
    if (!text) return mi.fact.mk === "ctor" ? { k: "in", t: mi.owner, args: [] } : null;
    const sc: Scope = { ...scopeOfMember(mi) };
    const tv = resolveTypeText(sc, text);
    if (!tv) return null;
    const sub = new Map<string, TypeValue>();
    if (via?.k === "in") {
      // map the declaring type's params; walk up if the member was inherited
      for (const [n, v] of genericMap(mi.owner.tparams, ownerArgs(via, mi.owner))) sub.set(n, v);
    }
    (mi.fact.tparams ?? []).forEach((n, i) => {
      if (targs[i]) sub.set(n, targs[i]);
    });
    return substitute(tv, sub);
  }

  /** The generic arguments `owner` gets when reached from `via` (through bases). */
  function ownerArgs(via: TypeValue, owner: TypeInfo): TypeValue[] {
    const seen = new Set<string>();
    let frontier: TypeValue[] = [via];
    for (let d = 0; d < 10 && frontier.length; d++) {
      const next: TypeValue[] = [];
      for (const cur of frontier) {
        if (cur.k === "in") {
          if (cur.t === owner) return cur.args;
          if (seen.has(cur.t.key)) continue;
          seen.add(cur.t.key);
          next.push(...directBases(cur));
        }
      }
      frontier = next;
    }
    return [];
  }

  function scopeOfMember(mi: MemberInfo): Scope {
    const facts = factsByFile.get(mi.file)!;
    const tf = facts.types.find((t) => t.id === mi.fact.owner);
    return { file: mi.file, facts, u: tf?.u ?? 0, type: mi.owner, method: mi };
  }

  function apiMemberType(f: Found, targs: TypeValue[]): TypeValue | null {
    if (!f.api) return null;
    const owner = f.api.owner;
    const sub = genericMap(owner.api?.g ?? [], ownerApiArgs(f.via, owner));
    return resolveApiType(targs.length && f.api.m.tg ? f.api.m.tg : f.api.m.t, sub, targs);
  }

  /** Generic args of an API owner type as reached from `via`. */
  function ownerApiArgs(via: TypeValue, owner: TypeValue & { k: "ex" }): TypeValue[] {
    if (via.k === "ex" && via.fqn === owner.fqn) return via.args;
    return owner.args;
  }

  /** Element type of a collection-like type value. */
  function elementOf(tv: TypeValue | null, dict: "pair" | "value" = "pair"): TypeValue | null {
    if (!tv) return null;
    if (tv.k === "arr") return tv.el;
    const seen = new Set<string>();
    let frontier: TypeValue[] = [tv];
    for (let d = 0; d < 8 && frontier.length; d++) {
      const next: TypeValue[] = [];
      for (const cur of frontier) {
        if (cur.k === "ex") {
          if (COLLECTION_1.has(cur.fqn) && cur.args[0]) return cur.args[0];
          if (DICTIONARY_2.has(cur.fqn) && cur.args.length === 2) {
            if (dict === "value") return cur.args[1];
            return exType("System.Collections.Generic.KeyValuePair", cur.args) ?? { k: "ex", fqn: "System.Collections.Generic.KeyValuePair`2", args: cur.args };
          }
        }
        const key = cur.k === "in" ? cur.t.key : cur.k === "ex" ? cur.fqn : "";
        if (seen.has(key)) continue;
        seen.add(key);
        next.push(...directBases(cur));
      }
      frontier = next;
    }
    return null;
  }

  function enumerableOf(el: TypeValue | null, fqn = ENUMERABLE): TypeValue | null {
    return el ? { k: "ex", fqn, args: [el], api: api.types[fqn] } : null;
  }

  // ── expressions ──
  const refsOut: MemberInfo[] = [];

  function scopeOfIntent(file: string, u: number, typeId: string | undefined, sourceId: string): Scope {
    const facts = factsByFile.get(file)!;
    let method = memberById.get(sourceId);
    // a local function's own generic params are rare; use its enclosing member
    if (method?.fact.mk === "local") method = undefined;
    return { file, facts, u, type: typeId ? (byId.get(typeId) ?? null) : null, method };
  }

  /** Members of the enclosing type chain named `name` (instance + static + inherited). */
  function enclosingMember(sc: Scope, name: string): { f: Found; self: TypeValue } | null {
    for (let t = sc.type; t; t = t.outer) {
      const self: TypeValue = { k: "in", t, args: t.tparams.map((n) => ({ k: "tp", name: n, bounds: [] }) as TypeValue) };
      const f = findMember(self, name);
      if (f) return { f, self };
    }
    return null;
  }

  function staticUsingMember(sc: Scope, name: string): Found | null {
    const chain = scopeChain(sc.facts, sc.u);
    for (let i = 0; i < chain.length; i++) {
      const statics = i === chain.length - 1 ? [...chain[i].statics, ...globalStatics] : chain[i].statics;
      for (const st of statics) {
        const tv = resolveTypeText({ ...sc, u: chain[i].parent >= 0 ? chain[i].parent : 0 }, st);
        if (!tv) continue;
        const f = findMember(tv, name);
        if (f) return f;
      }
    }
    return null;
  }

  function symOfFound(f: Found, recv: TypeValue | null, isStatic: boolean, targs: TypeValue[] = []): Sym {
    if (f.members.length) {
      const methods = f.members.filter((m) => m.fact.mk === "method" || m.fact.mk === "op");
      if (methods.length) return { k: "group", members: methods, recv, isStatic };
      const m = f.members[0];
      if (m.fact.mk === "enum") return { k: "val", tv: { k: "in", t: m.owner, args: [] }, member: m };
      return { k: "val", tv: memberType(m, f.via, targs), member: m };
    }
    if (f.api) {
      if (f.api.m.k === "m") return { k: "group", members: [], ext: [`${bareKey(f.api.owner.fqn)}.${f.api.name}`], recv, isStatic };
      return { k: "val", tv: apiMemberType(f, targs), ext: `${bareKey(f.api.owner.fqn)}.${f.api.name}` };
    }
    return null;
  }

  function evalExpr(sc: Scope, e: Expr | null | undefined, depth = 0): Sym {
    if (!e || depth > 30) return null;
    switch (e[0]) {
      case "i": {
        const name = e[1];
        const em = enclosingMember(sc, name);
        if (em) return symOfFound(em.f, em.self, false);
        const t = lookupTypeName(sc, name, 0, []);
        if (t) return "ns" in t ? { k: "ns", ns: t.ns } : { k: "type", tv: t };
        const st = staticUsingMember(sc, name);
        if (st) return symOfFound(st, null, true);
        return null;
      }
      case "t": {
        if (!sc.type) return null;
        return { k: "val", tv: { k: "in", t: sc.type, args: sc.type.tparams.map((n) => ({ k: "tp", name: n, bounds: [] }) as TypeValue) } };
      }
      case "b": {
        if (!sc.type) return null;
        const bases = basesOf(sc.type).filter((b) => !(b.k === "in" && b.t.kind === "interface") && !(b.k === "ex" && b.api?.k === "interface"));
        return bases[0] ? { k: "val", tv: bases[0] } : null;
      }
      case "m": {
        const r = evalExpr(sc, e[1], depth + 1);
        return memberAccess(sc, r, e[2], []);
      }
      case "c":
        return invoke(sc, e, depth);
      case "n": {
        const tv = e[1] === "?" ? null : resolveTypeText(sc, e[1]);
        return tv ? { k: "val", tv } : null;
      }
      case "N": {
        const t = evalExpr(sc, e[1], depth + 1);
        return t && (t.k === "val" || t.k === "type") ? { k: "val", tv: t.tv } : null;
      }
      case "x": {
        const r = evalExpr(sc, e[1], depth + 1);
        if (!r || r.k !== "val" || !r.tv) return null;
        if (r.tv.k === "in") {
          const f = findMember(r.tv, "this[]");
          if (f?.members.length) return { k: "val", tv: memberType(f.members[0], f.via, []) };
        }
        return { k: "val", tv: elementOf(r.tv, "value") };
      }
      case "e": {
        const r = evalExpr(sc, e[1], depth + 1);
        return r && r.k === "val" ? { k: "val", tv: elementOf(r.tv) } : null;
      }
      case "dv": {
        const r = evalExpr(sc, e[1], depth + 1);
        return r && r.k === "val" ? { k: "val", tv: elementOf(r.tv, "value") } : null;
      }
      case "T": {
        const tv = resolveTypeText(sc, e[1]);
        return tv ? { k: "val", tv } : null;
      }
      case "a": {
        const r = evalExpr(sc, e[1], depth + 1);
        if (!r || r.k !== "val" || !r.tv) return null;
        const tv = r.tv;
        if (tv.k === "ex" && /Task`1$|UniTask`1$|ValueTask`1$/.test(tv.fqn)) return { k: "val", tv: tv.args[0] ?? null };
        return { k: "val", tv: null };
      }
      case "g":
        return evalExpr(sc, e[1], depth + 1);
      case "tu": {
        const r = evalExpr(sc, e[1], depth + 1);
        if (!r || r.k !== "val" || !r.tv) return null;
        const tv = r.tv;
        if (tv.k === "ex" && /^System\.ValueTuple`\d+$/.test(tv.fqn)) return { k: "val", tv: tv.args[e[2]] ?? null };
        if (tv.k === "ex" && tv.fqn === "System.Collections.Generic.KeyValuePair`2") return { k: "val", tv: tv.args[e[2]] ?? null };
        return null;
      }
    }
    return null;
  }

  function memberAccess(sc: Scope, r: Sym, name: string, targs: TypeValue[]): Sym {
    if (!r) return null;
    if (r.k === "ns") {
      const t = inNamespace(r.ns, name, targs.length, targs);
      if (t && t !== "ambiguous") return { k: "type", tv: t };
      const sub = `${r.ns}.${name}`;
      if (namespaces.has(sub) || apiNamespaces.has(sub)) return { k: "ns", ns: sub };
      return null;
    }
    if (r.k === "type") {
      const nested = nestedIn(r.tv, name, 0, []);
      const f = findMember(r.tv, name);
      if (f) {
        const s = symOfFound(f, r.tv, true, targs);
        if (s?.k === "val" && s.member) refsOut.push(s.member);
        return s;
      }
      if (nested) return { k: "type", tv: nested };
      return null;
    }
    if (r.k === "val") {
      if (!r.tv) return null;
      const f = findMember(r.tv, name);
      if (f) {
        const s = symOfFound(f, r.tv, false, targs);
        if (s?.k === "val" && s.member) refsOut.push(s.member);
        return s;
      }
      // extension method group
      const ext = extensionsFor(r.tv, name);
      if (ext.length) return { k: "group", members: ext, recv: r.tv, isStatic: false };
      // collection pseudo-members
      if (name === "Value" || name === "Key") {
        const el = r.tv.k === "ex" && r.tv.fqn === "System.Collections.Generic.KeyValuePair`2" ? r.tv.args[name === "Key" ? 0 : 1] : null;
        return el ? { k: "val", tv: el } : null;
      }
      return null;
    }
    return null;
  }

  /** In-repo extension methods named `name` applicable to `recv`. */
  function extensionsFor(recv: TypeValue | null, name: string): MemberInfo[] {
    const cands = extensions.get(name) ?? [];
    if (!cands.length) return [];
    if (!recv) return cands.length === 1 ? cands : [];
    const out: MemberInfo[] = [];
    for (const c of cands) {
      const p0 = c.fact.params?.[0];
      if (!p0) continue;
      const sc = scopeOfMember(c);
      const pt = resolveTypeText(sc, p0.t);
      if (!pt) continue;
      if (pt.k === "tp" ? pt.bounds.every((b) => assignable(recv, b)) : assignable(recv, pt)) out.push(c);
    }
    return out;
  }

  /** Is a value of type `a` usable where `b` is expected (identity or base chain)? */
  function assignable(a: TypeValue, b: TypeValue): boolean {
    if (b.k === "ex" && (b.fqn === "System.Object")) return true;
    const seen = new Set<string>();
    let frontier: TypeValue[] = [a];
    for (let d = 0; d < 12 && frontier.length; d++) {
      const next: TypeValue[] = [];
      for (const cur of frontier) {
        if (sameType(cur, b)) return true;
        const k = cur.k === "in" ? cur.t.key : cur.k === "ex" ? cur.fqn : cur.k === "arr" ? "arr" : cur.name;
        if (seen.has(k)) continue;
        seen.add(k);
        next.push(...directBases(cur));
      }
      frontier = next;
    }
    // IEnumerable<T> extension on an array/collection
    if (b.k === "ex" && b.fqn === ENUMERABLE) return !!elementOf(a);
    return false;
  }

  function invoke(sc: Scope, e: Expr & { 0: "c" }, depth: number): Sym {
    const [, fn, argc, rawTargs, a0] = e as ["c", Expr, number, string[] | null | undefined, Expr | null | undefined];
    const targs = (rawTargs ?? []).map((t) => resolveTypeText(sc, t)).filter((x): x is TypeValue => !!x);
    let group: Sym = null;
    let name = "";
    let recvTv: TypeValue | null = null;
    if (fn[0] === "i") {
      name = fn[1];
      const em = enclosingMember(sc, name);
      if (em) {
        group = symOfFound(em.f, em.self, false, targs);
        recvTv = em.self;
      } else {
        const st = staticUsingMember(sc, name);
        if (st) group = symOfFound(st, null, true, targs);
      }
      if (!group) {
        // a delegate-typed type? `Foo()` where Foo is a type is a ctor call only via `new`
        return null;
      }
    } else if (fn[0] === "m") {
      name = fn[2];
      const r = evalExpr(sc, fn[1], depth + 1);
      if (r?.k === "val") recvTv = r.tv;
      if (r?.k === "type") recvTv = r.tv;
      group = memberAccess(sc, r, name, targs);
      if (!group && r?.k === "val" && !r.tv) {
        // unknown receiver: a uniquely-named in-repo extension method still matches
        const ext = extensionsFor(null, name);
        if (ext.length) group = { k: "group", members: ext, recv: null, isStatic: false };
      }
      // `x.GetComponent<T>()` is a T whatever x is — even when x itself is untyped
      if (!group && targs.length && (RETURNS_TARG.has(name) || RETURNS_TARG_ARRAY.has(name)) && !recvTv) {
        return { k: "val", tv: RETURNS_TARG.has(name) ? targs[0] : { k: "arr", el: targs[0] } };
      }
      // special forms the API may not carry
      if (!group && (r?.k === "val" || r?.k === "type") && recvTv) {
        const special = specialReturn(recvTv, name, targs);
        if (special !== undefined) return { k: "val", tv: special };
      }
    } else return null;

    if (!group) {
      // a value of delegate type being invoked (`OnHit(x)` where OnHit is an Action) → nothing to call
      if (fn[0] === "i") return null;
      return null;
    }
    if (group.k === "val") {
      // invoking a delegate-typed field/property/event: a reference, not a call
      if (group.member) refsOut.push(group.member);
      return { k: "val", tv: null };
    }
    if (group.k !== "group") return null;
    // pick overloads by argument count (extension methods count the receiver)
    const candidates = group.members.filter((m) => fitsArity(m, argc + (m.fact.ext && fn[0] === "m" && group.recv !== null ? 1 : 0)) || fitsArity(m, argc));
    const chosen = candidates.length ? candidates : group.members;
    called.push(...chosen);
    // result type
    if (chosen.length) {
      const m = chosen[0];
      if (m.fact.tparams?.length && !targs.length && RETURNS_TARG.has(name) && a0) {
        const at = evalExpr(sc, a0, depth + 1);
        if (at?.k === "val") return { k: "val", tv: at.tv };
      }
      const via = group.recv ?? (m.owner ? { k: "in", t: m.owner, args: [] } as TypeValue : null);
      return { k: "val", tv: memberType(m, via, targs) };
    }
    // external method: API return type
    if (group.ext?.length && recvTv) {
      const f = findMember(recvTv, name);
      if (f?.api) {
        let tv = apiMemberType(f, targs);
        if (!tv && a0 && name === "Instantiate") {
          const at = evalExpr(sc, a0, depth + 1);
          if (at?.k === "val") tv = at.tv;
        }
        if (!tv) {
          const special = specialReturn(recvTv, name, targs);
          if (special !== undefined) tv = special;
        }
        return { k: "val", tv };
      }
    }
    if (group.ext?.length && name === "Instantiate" && a0) {
      const at = evalExpr(sc, a0, depth + 1);
      if (at?.k === "val") return { k: "val", tv: at.tv };
    }
    return { k: "val", tv: null };
  }

  /** Results the API data can't express: LINQ over collections, generic Unity lookups. */
  function specialReturn(recv: TypeValue, name: string, targs: TypeValue[]): TypeValue | null | undefined {
    if (targs.length && RETURNS_TARG.has(name)) return targs[0];
    if (targs.length && RETURNS_TARG_ARRAY.has(name)) return { k: "arr", el: targs[0] };
    const el = elementOf(recv);
    if (!el) return undefined;
    if (ELEMENT_OF.has(name)) return el;
    if (name === "ToArray") return { k: "arr", el };
    if (name === "ToList" || name === "FindAll" || name === "GetRange") return enumerableOf(el, "System.Collections.Generic.List`1");
    if (SEQUENCE_OF.has(name)) return enumerableOf(el);
    if ((name === "OfType" || name === "Cast") && targs[0]) return enumerableOf(targs[0]);
    if (name === "Values" && recv.k === "ex" && DICTIONARY_2.has(recv.fqn)) return enumerableOf(recv.args[1]);
    if (name === "Keys" && recv.k === "ex" && DICTIONARY_2.has(recv.fqn)) return enumerableOf(recv.args[0]);
    return undefined;
  }

  function fitsArity(m: MemberInfo, argc: number): boolean {
    const ps = m.fact.params ?? [];
    const variadic = ps.at(-1)?.m === "params";
    const required = ps.filter((p) => p.m !== "params" && !p.d).length;
    if (argc < required) return false;
    return variadic || argc <= ps.length;
  }

  let called: MemberInfo[] = [];

  // ── overrides / implementations index (for dispatch and `overrides` edges) ──
  const subtypes = new Map<TypeInfo, TypeInfo[]>();
  for (const t of byKey.values()) {
    for (const b of basesOf(t)) if (b.k === "in") push(subtypes, b.t, t);
  }

  /** Members of subtypes overriding/implementing `m` (same name and parameter count). */
  function overridersOf(m: MemberInfo): MemberInfo[] {
    const out: MemberInfo[] = [];
    const arity = m.fact.params?.length ?? 0;
    const seen = new Set<TypeInfo>();
    const walk = (t: TypeInfo) => {
      for (const s of subtypes.get(t) ?? []) {
        if (seen.has(s)) continue;
        seen.add(s);
        for (const c of s.members.get(m.fact.name) ?? []) {
          if (c.fact.mk !== m.fact.mk && !(c.fact.mk === "method" && m.fact.mk === "method")) continue;
          if ((c.fact.params?.length ?? 0) !== arity) continue;
          if (m.owner.kind === "interface" || c.fact.mod === "override") out.push(c);
        }
        walk(s);
      }
    };
    walk(m.owner);
    return out;
  }

  // ── edges ──
  const out: EdgeV1[] = [];
  const seenEdge = new Map<string, EdgeV1>();
  const add = (source: string, target: string, relation: Relation, confidence: EdgeV1["confidence"], via?: string) => {
    if (!source || !target) return;
    if (relation !== "calls" && source === target) return;
    const key = `${source}\0${relation}\0${target}`;
    const prev = seenEdge.get(key);
    if (prev) {
      if (via && prev.via && !prev.via.split(", ").includes(via) && prev.via.length < 200) prev.via += `, ${via}`;
      return;
    }
    const edge: EdgeV1 = { source, target, relation, confidence };
    if (via) edge.via = via;
    seenEdge.set(key, edge);
    out.push(edge);
  };
  const conf = (file: string, targetId: string): EdgeV1["confidence"] =>
    nodeById.get(targetId)?.path === file ? "extracted" : "inferred";

  const typeTargets = (tv: TypeValue | null, acc: TypeInfo[] = []): TypeInfo[] => {
    if (!tv) return acc;
    if (tv.k === "in") {
      acc.push(tv.t);
      for (const a of tv.args) typeTargets(a, acc);
    } else if (tv.k === "ex") for (const a of tv.args) typeTargets(a, acc);
    else if (tv.k === "arr") typeTargets(tv.el, acc);
    return acc;
  };

  for (const e of rawEdges) {
    const cs = e.cs;
    if (!cs && !(e.targetId && e.relation !== "contains" && factsByFile.has(e.file))) continue;
    if (!cs) {
      add(e.source, e.targetId!, e.relation, "extracted");
      continue;
    }
    if (cs.to) {
      add(e.source, cs.to, e.relation, "extracted");
      continue;
    }
    const sc = scopeOfIntent(e.file, cs.u, cs.ty, e.source);
    if (e.relation === "extends") {
      // resolved via basesOf (keeps one resolution per type); here only for the edge
      const owner = byId.get(e.source);
      if (!owner) continue;
      const tv = resolveTypeText({ ...scopeFor(owner, Math.max(0, owner.ids.indexOf(e.source))), type: owner }, cs.t!);
      if (tv?.k === "in") add(e.source, tv.t.id, tv.t.kind === "interface" ? "implements" : "extends", conf(e.file, tv.t.id));
      else if (tv?.k === "ex") {
        const iface = tv.api?.k === "interface" || (!tv.api && /^I[A-Z]/.test(bareKey(tv.fqn).split(".").pop() ?? ""));
        add(e.source, fqnOf(tv), iface ? "implements" : "extends", "inferred");
      } else if (tv?.k === "tp") {
        /* a type parameter is never a supertype */
      } else {
        const bare = (parseType(cs.t!)?.parts.at(-1)?.n ?? cs.t!).replace(/`\d+$/, "");
        add(e.source, bare, /^I[A-Z]/.test(bare) ? "implements" : "extends", "inferred");
      }
      continue;
    }
    if (cs.t) {
      const tv = resolveTypeText(sc, cs.t) ?? (cs.via === "attribute" ? resolveTypeText(sc, cs.t.replace(/Attribute$/, "")) : null);
      for (const t of typeTargets(tv)) add(e.source, t.id, "references", conf(e.file, t.id));
      continue;
    }
    if (!cs.e) continue;
    refsOut.length = 0;
    called = [];
    let sym: Sym = null;
    try {
      sym = evalExpr(sc, cs.e);
    } catch {
      sym = null;
    }
    if (e.relation === "calls") {
      const e0 = cs.e;
      if (e0[0] === "n" || e0[0] === "N") {
        const tv = sym?.k === "val" ? sym.tv : null;
        if (tv?.k === "in") {
          const argc = e0[2];
          const ctors = (tv.t.members.get(tv.t.name) ?? []).filter((m) => m.fact.mk === "ctor" && fitsArity(m, argc));
          if (ctors.length) for (const c of ctors) add(e.source, c.fact.id, "calls", conf(e.file, c.fact.id));
          else add(e.source, tv.t.id, "calls", conf(e.file, tv.t.id));
        }
      } else if (e0[0] === "c" && e0[3]?.[0] === ".ctor") {
        // `: base(…)` / `: this(…)`
        const self = sc.type;
        const target = e0[1][0] === "b" ? (self ? basesOf(self).find((b) => b.k === "in" && b.t.kind !== "interface") : undefined) : self ? ({ k: "in", t: self, args: [] } as TypeValue) : undefined;
        if (target?.k === "in") {
          const ctors = (target.t.members.get(target.t.name) ?? []).filter((m) => m.fact.mk === "ctor" && fitsArity(m, e0[2]) && m.fact.id !== e.source);
          for (const c of ctors) add(e.source, c.fact.id, "calls", conf(e.file, c.fact.id));
        }
      } else {
        for (const m of called) {
          if (!m.fact.id) continue;
          add(e.source, m.fact.id, "calls", conf(e.file, m.fact.id));
          // dispatch to overrides/implementations of a virtual/abstract/interface member
          if (m.fact.mod === "virtual" || m.fact.mod === "abstract" || m.owner.kind === "interface" || m.fact.mod === "override") {
            for (const o of overridersOf(m)) if (o.fact.id) add(e.source, o.fact.id, "calls", "inferred");
          }
        }
      }
      for (const r of refsOut) if (r.fact.id) add(e.source, r.fact.id, "references", conf(e.file, r.fact.id));
      continue;
    }
    if (e.relation === "subscribes") {
      if (sym?.k === "group") for (const m of sym.members) if (m.fact.id) add(e.source, m.fact.id, "subscribes", conf(e.file, m.fact.id), cs.via);
      for (const r of refsOut) if (r.fact.id) add(e.source, r.fact.id, "references", conf(e.file, r.fact.id));
      continue;
    }
    if (e.relation === "references") {
      if (sym?.k === "group") for (const m of sym.members) if (m.fact.id) add(e.source, m.fact.id, "references", conf(e.file, m.fact.id));
      if (sym?.k === "val" && sym.member?.fact.id) add(e.source, sym.member.fact.id, "references", conf(e.file, sym.member.fact.id));
      if (sym?.k === "val" && sym.member && !sym.member.fact.id && sym.member.fact.mk === "enum") add(e.source, sym.member.owner.id, "references", conf(e.file, sym.member.owner.id));
      if (sym?.k === "type") for (const t of typeTargets(sym.tv)) add(e.source, t.id, "references", conf(e.file, t.id));
      for (const r of refsOut) if (r.fact.id) add(e.source, r.fact.id, "references", conf(e.file, r.fact.id));
      continue;
    }
  }

  // `overrides`: a member overriding a base member / implementing an interface member.
  for (const t of byKey.values()) {
    for (const [name, ms] of t.members) {
      for (const m of ms) {
        if (!m.fact.id || m.fact.mk === "ctor" || m.fact.mk === "cctor" || m.fact.mk === "local" || m.fact.mk === "enum") continue;
        const arity = m.fact.params?.length ?? 0;
        const targets = baseMembers(t, name, arity, m.fact.mk, m.fact.mod === "override", m.fact.iface);
        for (const b of targets) {
          if (typeof b === "string") add(m.fact.id, b, "overrides", "inferred");
          else if (b.fact.id) add(m.fact.id, b.fact.id, "overrides", conf(m.file, b.fact.id));
        }
      }
    }
  }

  function baseMembers(t: TypeInfo, name: string, arity: number, mk: string, isOverride: boolean, iface?: string): Array<MemberInfo | string> {
    const out: Array<MemberInfo | string> = [];
    const seen = new Set<string>();
    let frontier = basesOf(t);
    let classFound = false;
    for (let d = 0; d < 10 && frontier.length; d++) {
      const next: TypeValue[] = [];
      for (const b of frontier) {
        const k = b.k === "in" ? b.t.key : b.k === "ex" ? b.fqn : "";
        if (!k || seen.has(k)) continue;
        seen.add(k);
        if (b.k === "in") {
          const isIface = b.t.kind === "interface";
          if (iface && !isIface) {
            next.push(...directBases(b));
            continue;
          }
          const hits = (b.t.members.get(name) ?? []).filter((x) => (x.fact.params?.length ?? 0) === arity && (x.fact.mk === mk || (mk === "method" && x.fact.mk === "method")));
          if (hits.length && (isIface || (isOverride && !classFound))) {
            out.push(...hits);
            if (!isIface) classFound = true;
          }
        } else if (b.k === "ex") {
          const a = b.api;
          if (a && (a.vm?.includes(name) || (a.k === "interface" && a.m?.[name])) && (isOverride || a.k === "interface") && !classFound) {
            out.push(`${bareKey(b.fqn).replace(/`\d+/g, "")}.${name}`);
            if (a.k !== "interface") classFound = true;
          }
        }
        next.push(...directBases(b));
      }
      frontier = next;
    }
    return out;
  }

  const model: CsModel = {
    types: [...byKey.values()],
    byId,
    memberById,
    api,
    derivesFrom(t, fqn) {
      return model.baseChain(t).some((b) => (b.k === "ex" && bareKey(b.fqn) === fqn) || (b.k === "in" && fqnOf(b) === fqn));
    },
    typesNamed(name) {
      return typesByName.get(name) ?? [];
    },
    baseChain(t) {
      const outList: TypeValue[] = [];
      const seen = new Set<string>();
      let frontier: TypeValue[] = basesOf(t);
      for (let d = 0; d < 16 && frontier.length; d++) {
        const next: TypeValue[] = [];
        for (const b of frontier) {
          const k = b.k === "in" ? b.t.key : b.k === "ex" ? b.fqn : "";
          if (!k || seen.has(k)) continue;
          seen.add(k);
          outList.push(b);
          next.push(...directBases(b));
        }
        frontier = next;
      }
      return outList;
    },
    resolveTypeIn(file, u, typeId, text) {
      const facts = factsByFile.get(file);
      if (!facts) return null;
      return resolveTypeText({ file, facts, u, type: typeId ? (byId.get(typeId) ?? null) : null }, text);
    },
    membersOf(t, name) {
      const f = findMember({ k: "in", t, args: [] }, name);
      return f?.members ?? [];
    },
    typeOf(file, u, typeId, sourceId, e) {
      if (!factsByFile.has(file)) return null;
      refsOut.length = 0;
      called = [];
      const s = evalExpr(scopeOfIntent(file, u, typeId, sourceId), e);
      return s?.k === "val" || s?.k === "type" ? s.tv : null;
    },
    memberOf(file, u, typeId, sourceId, e) {
      if (!factsByFile.has(file)) return null;
      refsOut.length = 0;
      called = [];
      const s = evalExpr(scopeOfIntent(file, u, typeId, sourceId), e);
      return s?.k === "val" ? (s.member ?? null) : null;
    },
    constValues(file, u, typeId, sourceId, e) {
      if (!factsByFile.has(file)) return null;
      refsOut.length = 0;
      called = [];
      const s = evalExpr(scopeOfIntent(file, u, typeId, sourceId), e);
      const m = s?.k === "val" ? s.member : undefined;
      if (!m?.fact.sv) return null;
      const values: string[] = [];
      for (const v of m.fact.sv) {
        if (v.every((p) => typeof p === "string")) values.push((v as string[]).join(""));
        else {
          // nested constant reference: resolve one level in the member's own scope
          const msc = scopeOfMember(m);
          let acc: string[] = [""];
          for (const p of v) {
            if (typeof p === "string") acc = acc.map((a) => a + p);
            else if (p === null) acc = acc.map((a) => `${a}\0`);
            else {
              const inner = model.constValues(msc.file, msc.u, msc.type?.id, m.fact.id, p[1]);
              acc = inner ? acc.flatMap((a) => inner.values.map((x) => a + x)) : acc.map((a) => `${a}\0`);
            }
          }
          values.push(...acc.map((a) => a.split("\0")[0] + (a.includes("\0") ? "\0" : "")));
        }
      }
      return { values, hash: m.fact.hash };
    },
    fqnOf,
  };
  return { edges: out, model };
}

function push<K, V>(map: Map<K, V[]>, key: K, val: V): void {
  const arr = map.get(key);
  if (arr) arr.push(val);
  else map.set(key, [val]);
}
