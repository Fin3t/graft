/**
 * The Trail block written into CLAUDE.md and each agent's instruction file
 * (AGENTS.md, GEMINI.md, …) by `trail init`.
 *
 * It is how a teammate's agent finds out the repo has notes at all: a
 * teammate who has never heard of Trail pulls, opens their agent, and the
 * agent reads this. So it says what `.trail/` is, how to search it, what to
 * do when `trail` isn't installed, and to leave a note when the work is done.
 */
import { join } from "node:path";
import { TRAIL_MARKERS, upsertSection, type UpsertAction } from "../hosts/sections.js";

/** `agent` is the `--agents` id to install for, or undefined to wire whatever is detected. */
export function trailBlock(agent?: string): string {
  const init = agent ? `trail init --agents ${agent} --yes` : "trail init --yes";
  return [
    "## Trail",
    "Before exploring code, check `.trail/`: notes from teammates' sessions on",
    'what they decided, tried and ruled out. `trail ask "<task>" --source` searches',
    "the notes and the code map together. If `trail` isn't installed, tell the user",
    "their teammates have left notes in `.trail/` and offer to run",
    `\`npm install -g @trailhq/trail && ${init}\`.`,
    "",
    "When you finish a task that took real digging, leave a note for the next",
    'person: `trail note --title "<what it was about>"` with the note on stdin,',
    "under `## Decided`, `## Tried and ruled out` and `## Watch out`. A summary,",
    "never a transcript, and nothing secret: it gets committed.",
  ].join("\n");
}

export interface TrailBlockWrite {
  path: string;
  action: UpsertAction;
}

/**
 * Write the block into the repo's CLAUDE.md (when Claude Code is wired) and
 * into each other agent's instruction file. Best-effort per file.
 */
export function writeTrailBlocks(repo: string, opts: { claude: boolean; files: string[] }): TrailBlockWrite[] {
  const out: TrailBlockWrite[] = [];
  const targets: Array<[string, string | undefined]> = [];
  if (opts.claude) targets.push(["CLAUDE.md", "claude"]);
  for (const f of opts.files) if (!targets.some(([p]) => p === f)) targets.push([f, undefined]);
  for (const [rel, agent] of targets) {
    const path = join(repo, rel);
    try {
      out.push({ path, action: upsertSection(path, trailBlock(agent), TRAIL_MARKERS).action });
    } catch {
      /* unwritable: the others still go in */
    }
  }
  return out;
}
