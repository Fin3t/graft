/**
 * CLI wiring for `graft callers` and its `--direction` / `--depth` flags.
 *
 * One command, one implementation: resolve a symbol via `resolveSymbol`, walk
 * edges via `edgeWalk` (incoming or outgoing, depth 1 or a BFS), and share the
 * same resolve-or-die flow, human formatter, and --json shape. Kept out of
 * cli.ts so that file stays thin (argument wiring only) and this logic stays
 * unit-testable without shelling out to the CLI on every case.
 *
 * `--direction out` subsumes the old `graft callees`; `--depth N` subsumes the
 * old `graft impact`. Exported formatters are reused by the MCP `graft_trace_calls`
 * tool (`src/mcp/tools.ts`), so both surfaces render identical reports.
 */
import { resolve } from "node:path";
import { fileReader, referenceLine, wordRe } from "../blast/evidence.js";
import { contextDirFor } from "../context/node-file.js";
import { withSavings, savingsFor, type Savings } from "../context/savings.js";
import { loadGraphCached } from "./load.js";
import { resolveSymbol, edgeWalk, type Direction, type EdgeHit } from "./traverse.js";
import type { GraphV1, NodeV1 } from "./types.js";

export interface CallersCliOptions {
  in?: string;
  json?: boolean;
  /** walk direction; defaults to "in" (callers). "out" gives callees. */
  direction?: string;
  /** max BFS depth, as the raw --depth string (validated here); defaults to 1. */
  depth?: string;
  /** the top-level `--dir` override, so this command respects it like every other. */
  globalDir?: string;
}

const ARROW: Record<Direction, "←" | "→"> = { in: "←", out: "→" };
const DEFAULT_DEPTH = 1;

/** Exported so the MCP `graft_trace_calls` tool (`src/mcp/tools.ts`) can render the
 * same human report format as the CLI, rather than re-implementing it — both
 * surfaces walk the same edges via the same `resolveSymbol` / `edgeWalk` core. */
export function headerOf(n: NodeV1): string {
  const pkg = n.pkg ? ` · package ${n.pkg} (third-party)` : "";
  const asm = n.asm ? ` · assembly ${n.asm}` : "";
  const head = `${n.name} · ${n.kind} · ${n.path}:${n.span}${pkg}${asm}`;
  // Called by the engine / an editor / the test runner rather than by repo code:
  // say so up front, so an empty callers list never reads as dead code.
  const names = n.names ? `\n  ↳ names ${n.names}` : "";
  return n.entry ? `${head}\n  ⚙ ${n.entry}${names}` : `${head}${names}`;
}

/** `showDepth` is set for multi-hop walks (depth > 1), matching the old
 * `graft impact` output which tagged every hit with its BFS depth.
 *
 * `quote`, when given, is the call site itself — the line inside the hit where it
 * references the symbol. An edge that says "total calls add" is a claim; the line
 * under it is the evidence, and it saves opening the file to check.
 */
export function hitLine(direction: Direction, hit: EdgeHit, showDepth: boolean, quote?: Quote): string {
  const arrow = ARROW[direction];
  const depthTag = showDepth ? ` [depth ${hit.depth}]` : "";
  // A scene/prefab component is named after its GameObject ("Window A"); its
  // hierarchy path ("Shell/Section 2/Window A") is what tells two of them apart.
  const display =
    hit.node?.kind === "component"
      ? (/ on "(.*?)"( · .*)?$/.exec(hit.node.signature ?? "")?.slice(1, 3).join("") ?? hit.node.name)
      : hit.node?.kind === "file" && / of (Assets|Packages)\//.test(hit.node.signature ?? "")
        ? `${hit.node.name} — ${hit.node.signature}`
        : hit.node?.name;
  const label = hit.node
    ? `${display} (${hit.node.path}:${hit.node.span})${hit.node.pkg ? ` [package ${hit.node.pkg}]` : ""}`
    : `${hit.id} (${hit.relation === "imports" ? "unresolved import" : "outside the repo"})`;
  const via = hit.via ? ` via ${hit.via}` : "";
  const line = `  ${hit.relation} ${arrow} ${label}${via}${depthTag}`;
  return quote ? `${line}\n      ${quote.n}: ${quote.text.trim()}` : line;
}

/** A quoted source line: where the edge actually happens. */
interface Quote {
  n: number;
  text: string;
}

/**
 * The call site for one hit, or nothing.
 *
 * Only for a resolved hit whose span we can read: an unresolved import has no
 * file, and a hit at depth 2+ references something in between rather than the
 * symbol asked about, so quoting it would point at the wrong line.
 */
function quoteFor(
  hit: EdgeHit,
  name: string,
  read: (path: string) => string[] | null,
): Quote | undefined {
  if (!hit.node || hit.depth > 1) return undefined;
  return referenceLine(hit.node.path, hit.node.span, [wordRe(name)], read) ?? undefined;
}

/** Tokens-saved baseline for a callers/callees walk: the files of the matched
 * symbols plus every resolved edge endpoint, read whole — the files you'd open
 * to trace these edges by hand. Shared by the CLI and the MCP tool so both
 * surfaces report the same number. */
export function callersSavings(
  graph: GraphV1,
  results: { symbol: NodeV1; hits: EdgeHit[] }[],
): Savings | undefined {
  const paths: string[] = [];
  for (const { symbol, hits } of results) {
    paths.push(symbol.path);
    for (const h of hits) if (h.node) paths.push(h.node.path);
  }
  return savingsFor(graph, paths);
}

/** Loud, actionable empty-result note — never a bare empty list. `candidateCount`
 * is how many nodes {@link resolveSymbol} matched for this query (both call
 * sites already hold it as `matches.length`) — when it's >1, the query name is
 * itself ambiguous (several definitions share it), which is exactly the case
 * `resolve.ts` drops a cross-file call/reference for rather than guessing which
 * one it means. Without saying so, a zero-hit result here reads as "nothing
 * calls this" when it may really be "something does, but the edge was dropped". */
export function looseNoteFor(direction: Direction, name: string, candidateCount: number, entry?: string): string {
  if (entry && direction === "in") return "  no callers in the repo's code — it is called by the engine/tooling (see ⚙ above)";
  const label = direction === "out" ? "callees" : "callers";
  const dir = direction === "out" ? "outgoing" : "incoming";
  const ambiguity =
    candidateCount > 1
      ? ` ${candidateCount} definitions share the name "${name}"; a cross-file caller of an ambiguous name is dropped rather than guessed, so this may undercount.`
      : "";
  return `  no indexed ${label} — the graph has no ${dir} call/reference edges for this symbol as written.${ambiguity} Check the name (try the bare symbol, or "Type.method"), or find its uses with graft grep "${name}". Fall back to raw grep -rn only for unindexed files`;
}

interface SymbolJson {
  id: string;
  name: string;
  kind: string;
  path: string;
  span: string;
  entry?: string;
}

interface MatchJson {
  symbol: SymbolJson;
  hits: HitJson[];
  note?: string;
}

interface HitJson {
  id: string;
  name?: string;
  kind?: string;
  path?: string;
  span?: string;
  relation: string;
  depth: number;
  via?: string;
}

function symbolJson(n: NodeV1): SymbolJson {
  const out: SymbolJson = { id: n.id, name: n.name, kind: n.kind, path: n.path, span: n.span };
  if (n.entry) out.entry = n.entry;
  return out;
}

function hitJson(hit: EdgeHit): HitJson {
  const out: HitJson = { id: hit.id, relation: hit.relation, depth: hit.depth };
  if (hit.via) out.via = hit.via;
  if (hit.node) {
    out.name = hit.node.name;
    out.kind = hit.node.kind;
    out.path = hit.node.path;
    out.span = hit.node.span;
  }
  return out;
}

/** Wiring before mentions: calls, engine/asset wiring and heritage first, plain
 * `references` (a type named in a signature, a field read) last — stable within
 * each group. A class used in 100 signatures must not bury the 8 prefabs that
 * actually carry it. */
export function orderHits(hits: EdgeHit[]): EdgeHit[] {
  const rank = (h: EdgeHit) => (h.relation === "references" ? 1 : 0);
  return hits.map((h, i) => ({ h, i })).sort((a, b) => rank(a.h) - rank(b.h) || a.i - b.i).map((x) => x.h);
}

/** Parse and validate the raw `--direction` string; exits (code 1) on garbage. */
function resolveDirection(raw: string | undefined): Direction {
  if (raw === undefined) return "in";
  if (raw === "in" || raw === "out") return raw;
  console.error(`✗ --direction must be "in" or "out", got "${raw}"`);
  process.exit(1);
}

/**
 * Resolve `query` in the graph at `dir` (respecting `--dir`/`--in`), walk edges
 * per `--direction`/`--depth`, and print either the human report or `--json`.
 * Exits the process (code 1) when there's no graph at all or the symbol is
 * unknown — both are caller-facing mistakes, not recoverable states.
 */
export function runCallersCommand(query: string, dir: string, opts: CallersCliOptions): void {
  const root = resolve(dir);
  const contextDir = contextDirFor(root, opts.globalDir);
  const graph = loadGraphCached(contextDir);
  if (!graph) {
    console.error(`✗ no graph found at ${contextDir} — run \`graft build\` first`);
    process.exit(1);
  }

  // `resolveSymbol` throws on an `--in` prefix that matches nothing indexed —
  // a caller mistake, reported in the same shape as the ones around it rather
  // than as a bare stack-trace message from the top-level handler.
  let matches: NodeV1[];
  try {
    matches = resolveSymbol(graph, query, opts.in ? { in: opts.in } : {});
  } catch (err) {
    console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
    return;
  }
  if (matches.length === 0) {
    console.error(`✗ no symbol "${query}" in the graph — check spelling or run graft build`);
    process.exit(1);
  }

  const direction = resolveDirection(opts.direction);
  let depth = DEFAULT_DEPTH;
  if (opts.depth !== undefined) {
    // `all` (aka full/max) = the whole transitive closure: walk until no new
    // node is reached. The BFS's visited-set makes this cycle-safe, and it
    // terminates when the frontier empties. This is the "show me every
    // connected source" mode — the right first move before a multi-file
    // refactor, where stopping at direct edges misses sibling/downstream files.
    if (/^(all|full|max)$/i.test(opts.depth)) {
      depth = Number.POSITIVE_INFINITY;
    } else {
      const d = Number(opts.depth);
      if (!Number.isFinite(d) || d < 1) {
        console.error(`✗ --depth must be a positive number or "all", got "${opts.depth}"`);
        process.exit(1);
      }
      depth = Math.floor(d);
    }
  }
  const showDepth = depth > 1;

  const results = matches.map((symbol) => ({ symbol, hits: orderHits(edgeWalk(graph, symbol, direction, depth)) }));
  const saved = callersSavings(graph, results);

  if (opts.json) {
    const payload = {
      query,
      matches: results.map((r): MatchJson => {
        const m: MatchJson = { symbol: symbolJson(r.symbol), hits: r.hits.map(hitJson) };
        if (r.hits.length === 0) {
          m.note = looseNoteFor(direction, r.symbol.name, matches.length, r.symbol.entry);
        }
        return m;
      }),
      saved,
    };
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  const lines: string[] = [];
  // One reader for the whole walk: several hits usually live in the same file.
  const read = fileReader(root);
  for (const { symbol, hits } of results) {
    lines.push(headerOf(symbol));
    if (hits.length === 0) lines.push(looseNoteFor(direction, symbol.name, matches.length, symbol.entry));
    else for (const h of hits) lines.push(hitLine(direction, h, showDepth, quoteFor(h, symbol.name, read)));
    lines.push("");
  }
  const body = lines.join("\n").replace(/\n+$/, "\n");
  process.stdout.write(withSavings(body, saved));
}
