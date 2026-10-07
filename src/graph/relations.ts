/**
 * Edges that carry dependency meaning for a graph walk/rank: `calls`,
 * `references`, `imports`, `implements`, `extends`. `contains` is deliberately
 * excluded — a file "contains" every symbol defined in it, so walking it
 * would make every same-file symbol a neighbour and let a file act as a false
 * hub, flooding a walk that must stay confined to genuine dependency wiring.
 *
 * Shared by `traverse.ts` (callers/callees/impact edge walks), `graphrank.ts`
 * (personalized PageRank), and `search/grep.ts` (in-degree ranking) so every
 * surface agrees on what counts as a dependency edge.
 */
import type { Relation } from "./types.js";

export const WALK_RELATIONS: ReadonlySet<Relation> = new Set<Relation>([
  "calls",
  "references",
  "imports",
  "implements",
  "extends",
  // C# and the Unity asset layer: each is a dependency — changing the target can
  // change what the source does (an override, a subscribed handler, the class a
  // scene's component runs, the prefab it nests, the method a button invokes, the
  // asset a string loads, the file an assembly compiles).
  "overrides",
  "subscribes",
  "attaches",
  "nests",
  "variant_of",
  "instance_of",
  "assigns",
  "invokes",
  "loads",
  "sets",
  "plays",
  "uses_shader",
  "compiles",
]);
