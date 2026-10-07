/**
 * Graph-rank re-ranking for `graft ask` — the fix for lexical keyword-collision.
 *
 * Pure term-overlap ranking treats every node independently, so a node that
 * merely shares a word with the query (a window "overlay" widget) can outrank
 * the node the query is actually about (a scroll-"overlay" config) purely on
 * word count. The graph knows better: the right node is the one wired into the
 * cluster of code the query touches.
 *
 * This module runs personalized PageRank (random-walk-with-restart) over the
 * wiring graph, seeded by the lexical scores. Mass concentrates on nodes that
 * are edge-connected to the matched set; a lexically-matched but structurally
 * isolated node keeps only its own restart mass and sinks. "Lexical proposes,
 * graph disposes." Deterministic, $0, no embeddings — a lexical-seed →
 * graph-rank pipeline, the established alternative to vector search for code.
 */
import type { GraphV1 } from "../graph/types.js";
import { WALK_RELATIONS } from "../graph/relations.js";

export interface PageRankOptions {
  /** Restart probability — the mass that teleports back to the seed set each
   * step. Higher keeps the walk closer to the seeds. 0.25 is the standard value. */
  alpha?: number;
  /** Power-iteration count. 25 is plenty to converge on graphs this size. */
  iters?: number;
  /** Restrict the walk to a subgraph: when present, an edge counts only when
   * BOTH endpoints pass, and only passing ids can hold rank mass or seed
   * weight. Seeds outside the filter are silently ignored (same as a seed
   * naming a non-existent node). Omit for the full-graph walk (unchanged
   * behavior). */
  nodeFilter?: (id: string) => boolean;
}

/** Immutable graph topology consumed by the PageRank iteration. Preparing it
 * separately lets a multi-scope query partition one large graph once, instead
 * of rescanning every node and edge for every scope. */
export interface PageRankTopology {
  ids: ReadonlySet<string>;
  adjacency: ReadonlyMap<string, readonly string[]>;
}

export type PageRankRunOptions = Pick<PageRankOptions, "alpha" | "iters">;

interface MutablePageRankTopology {
  ids: Set<string>;
  adjacency: Map<string, string[]>;
}

const emptyTopology = (): PageRankTopology => ({
  ids: new Set<string>(),
  adjacency: new Map<string, readonly string[]>(),
});

const link = (adjacency: Map<string, string[]>, source: string, target: string): void => {
  const neighbours = adjacency.get(source);
  if (neighbours) neighbours.push(target);
  else adjacency.set(source, [target]);
};

/** Build independent PageRank topologies in one node pass and one edge pass.
 * Edges crossing partitions are excluded, exactly like applying a nodeFilter
 * for each partition independently. Returning `undefined` omits a node. */
export function preparePageRankPartitions(
  graph: GraphV1,
  partitionOfId: (id: string) => string | undefined,
): Map<string, PageRankTopology> {
  const partitionById = new Map<string, string>();
  const mutable = new Map<string, MutablePageRankTopology>();

  for (const node of graph.nodes) {
    const partition = partitionOfId(node.id);
    if (partition === undefined) continue;
    partitionById.set(node.id, partition);
    const topology = mutable.get(partition);
    if (topology) topology.ids.add(node.id);
    else mutable.set(partition, { ids: new Set([node.id]), adjacency: new Map() });
  }

  for (const edge of graph.edges) {
    if (!WALK_RELATIONS.has(edge.relation)) continue;
    const partition = partitionById.get(edge.source);
    if (partition === undefined || partitionById.get(edge.target) !== partition) continue;
    const topology = mutable.get(partition)!;
    link(topology.adjacency, edge.source, edge.target);
    link(topology.adjacency, edge.target, edge.source);
  }

  return new Map(mutable);
}

/** Prepare one optionally filtered topology. Kept public for callers/tests that
 * reuse the same graph across multiple seed sets. */
export function preparePageRankTopology(
  graph: GraphV1,
  nodeFilter?: (id: string) => boolean,
): PageRankTopology {
  const ids = new Set(
    graph.nodes.map((node) => node.id).filter((id) => !nodeFilter || nodeFilter(id)),
  );
  if (ids.size === 0) return emptyTopology();

  const adjacency = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (!WALK_RELATIONS.has(edge.relation)) continue;
    if (!ids.has(edge.source) || !ids.has(edge.target)) continue;
    link(adjacency, edge.source, edge.target);
    link(adjacency, edge.target, edge.source);
  }
  return { ids, adjacency };
}

/**
 * Personalized PageRank over the wiring graph.
 *
 * `seeds` maps node id → restart weight (a node's lexical score; only positive
 * weights matter). The graph is treated as UNDIRECTED — for "understand this
 * area" a callee is as relevant as a caller. Returns a score per node
 * normalized so the top node is 1; nodes untouched by the walk are absent.
 *
 * Edges whose endpoints aren't both real nodes (e.g. an unresolved import
 * module string) are ignored, so only genuine symbol-to-symbol wiring counts.
 */
export function personalizedPageRank(
  graph: GraphV1,
  seeds: Map<string, number>,
  opts: PageRankOptions = {},
): Map<string, number> {
  return personalizedPageRankPrepared(
    preparePageRankTopology(graph, opts.nodeFilter),
    seeds,
    opts,
  );
}

/** Run PageRank on an already prepared topology. This is numerically identical
 * to {@link personalizedPageRank}; it only removes repeated topology scans. */
export function personalizedPageRankPrepared(
  topology: PageRankTopology,
  seeds: Map<string, number>,
  opts: PageRankRunOptions = {},
): Map<string, number> {
  const alpha = opts.alpha ?? 0.25;
  const iters = opts.iters ?? 25;
  const ids = topology.ids;

  // Restart distribution: seed weights, restricted to real nodes, normalized.
  let seedTotal = 0;
  for (const [id, w] of seeds) if (ids.has(id) && w > 0) seedTotal += w;
  if (seedTotal <= 0) return new Map();
  const csr = csrOf(topology);
  const restartIdx: number[] = [];
  const restartVal: number[] = [];
  for (const [id, w] of seeds) {
    if (!ids.has(id) || w <= 0) continue;
    restartIdx.push(csr.index.get(id)!); // `seeds` keys are unique, so are these
    restartVal.push(w / seedTotal);
  }

  // Power iteration. Same arithmetic in the same order as the Map-based version
  // this replaced (insertion order = traversal order), so scores are
  // bit-identical — only the Map lookups on string ids are gone.
  const n = csr.names.length;
  let rank = new Float64Array(n);
  let next = new Float64Array(n);
  let order: number[] = [];
  let nextOrder: number[] = [];
  const seen = new Uint32Array(n); // generation stamp: set membership of `next`
  let gen = 1;
  for (let k = 0; k < restartIdx.length; k++) {
    rank[restartIdx[k]] = restartVal[k];
    order.push(restartIdx[k]);
  }
  const add = (i: number, v: number) => {
    if (seen[i] !== gen) {
      seen[i] = gen;
      next[i] = v;
      nextOrder.push(i);
    } else next[i] += v;
  };
  for (let it = 0; it < iters; it++) {
    gen++;
    nextOrder = [];
    // Teleport: every step, alpha of the mass returns to the seed set.
    for (let k = 0; k < restartIdx.length; k++) {
      const i = restartIdx[k];
      seen[i] = gen;
      next[i] = alpha * restartVal[k];
      nextOrder.push(i);
    }
    // Dangling mass (nodes with no walk edges) is pooled and returned to the
    // seed set ONCE per iteration — same math as redistributing per node, but
    // O(nodes + seeds) instead of O(dangling × seeds).
    let dangling = 0;
    for (const i of order) {
      const mass = rank[i];
      const from = csr.offsets[i];
      const to = csr.offsets[i + 1];
      if (to === from) {
        dangling += mass;
        continue;
      }
      const share = ((1 - alpha) * mass) / (to - from);
      for (let e = from; e < to; e++) add(csr.targets[e], share);
    }
    if (dangling > 0) {
      const dm = (1 - alpha) * dangling;
      for (let k = 0; k < restartIdx.length; k++) add(restartIdx[k], dm * restartVal[k]);
    }
    const tmp = rank;
    rank = next;
    next = tmp;
    order = nextOrder;
  }

  let max = 0;
  for (const i of order) if (rank[i] > max) max = rank[i];
  if (max <= 0) return new Map();
  const out = new Map<string, number>();
  for (const i of order) out.set(csr.names[i], rank[i] / max);
  return out;
}

interface Csr {
  names: string[];
  index: Map<string, number>;
  offsets: Int32Array;
  targets: Int32Array;
}

const csrCache = new WeakMap<PageRankTopology, Csr>();

/** The topology as integer arrays (compressed sparse rows), neighbours kept in
 * adjacency order. Built once per topology. */
function csrOf(topology: PageRankTopology): Csr {
  const hit = csrCache.get(topology);
  if (hit) return hit;
  const names = [...topology.ids];
  const index = new Map(names.map((id, i) => [id, i]));
  const offsets = new Int32Array(names.length + 1);
  let total = 0;
  names.forEach((id, i) => {
    offsets[i] = total;
    total += topology.adjacency.get(id)?.length ?? 0;
  });
  offsets[names.length] = total;
  const targets = new Int32Array(total);
  names.forEach((id, i) => {
    const nbrs = topology.adjacency.get(id);
    if (nbrs) for (let k = 0; k < nbrs.length; k++) targets[offsets[i] + k] = index.get(nbrs[k])!;
  });
  const csr = { names, index, offsets, targets };
  csrCache.set(topology, csr);
  return csr;
}
