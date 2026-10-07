/**
 * `.trail/notes/`: one note per session, written by `trail note`, read back by
 * `ask` for the next person who works on the same thing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  costLabel,
  ensureTrailDir,
  findNotes,
  formatNoteHits,
  listNotes,
  parseNote,
  renderNote,
  sectionLead,
  shortDate,
  slug,
  tokensLabel,
  writeNote,
  type Note,
} from "../src/notes/notes.js";
import { costFromTranscript } from "../src/notes/session-cost.js";
import { trailBlock } from "../src/notes/instructions.js";
import { homeEnv, tmpRepo } from "./helpers.js";

const BODY = [
  "## Decided",
  "Rotate each box in `NormalizeBox` by its own page's `/Rotate` before scaling.",
  "",
  "## Tried and ruled out",
  "- Rotating the image before OCR. Works, but doubles latency on long files.",
  "",
  "## Watch out",
  "`/Rotate` can be 270 on a single page inside an otherwise upright file.",
].join("\n");

function note(over: Partial<Note> = {}): Note {
  return {
    path: ".trail/notes/2026-10-07-bbox-priya.md",
    title: "Bbox coordinates are off on rotated PDFs",
    author: "Priya",
    date: "2026-10-07",
    branch: "fix/bbox-rotation",
    cost: { minutes: 12, tokens: 9600 },
    touches: ["internal/ocr/bbox.go#NormalizeBox", "internal/ocr/client.go"],
    body: BODY,
    ...over,
  };
}

// --- the file format ---

test("a note round-trips through its file, frontmatter and all", () => {
  const n = note();
  const text = renderNote(n);
  assert.match(text, /^---\ntitle: Bbox coordinates are off on rotated PDFs\nauthor: Priya\ndate: 2026-10-07\nbranch: fix\/bbox-rotation\ncost: \{ minutes: 12, tokens: 9600 \}\ntouches:\n  - "internal\/ocr\/bbox.go#NormalizeBox"\n  - internal\/ocr\/client.go\n---\n\n## Decided/);
  assert.deepEqual(parseNote(text, n.path), n);
});

test("titles that YAML would misread are quoted, and still come back intact", () => {
  const n = note({ title: "Retries: why #3 fails", touches: [], cost: undefined, branch: undefined });
  assert.equal(parseNote(renderNote(n), n.path)?.title, "Retries: why #3 fails");
});

test("a file without a title isn't a note", () => {
  assert.equal(parseNote("# just markdown\n", "x.md"), null);
  assert.equal(parseNote("---\nauthor: x\n---\nbody", "x.md"), null);
});

test("writeNote names the file by date, title and author, and never overwrites", () => {
  const repo = tmpRepo("notes-write");
  const a = writeNote(repo, { title: "Bbox coordinates are off on rotated PDFs", body: BODY, author: "Priya", date: "2026-10-07" });
  const b = writeNote(repo, { title: "Bbox coordinates are off on rotated PDFs", body: "again", author: "Priya", date: "2026-10-07" });
  assert.equal(a.path, ".trail/notes/2026-10-07-bbox-coordinates-are-off-on-rotated-priya.md");
  assert.equal(b.path, ".trail/notes/2026-10-07-bbox-coordinates-are-off-on-rotated-priya-2.md");
  assert.match(readFileSync(join(repo, a.path), "utf8"), /Rotate each box/);
  assert.equal(listNotes(repo).length, 2);
});

test("ensureTrailDir writes the README once and keeps someone's edits", () => {
  const repo = tmpRepo("notes-dir");
  assert.equal(ensureTrailDir(repo).created, true);
  assert.match(readFileSync(join(repo, ".trail", "README.md"), "utf8"), /^# \.trail/);
  assert.ok(existsSync(join(repo, ".trail", "notes", ".gitkeep")));
  writeFileSync(join(repo, ".trail", "README.md"), "ours\n");
  assert.equal(ensureTrailDir(repo).created, false);
  assert.equal(readFileSync(join(repo, ".trail", "README.md"), "utf8"), "ours\n");
});

test("small formatting helpers", () => {
  assert.equal(slug("Bbox coordinates are off on rotated PDFs!"), "bbox-coordinates-are-off-on-rotated");
  assert.equal(shortDate("2026-10-07"), "Oct 7");
  assert.equal(tokensLabel(9600), "~9.6k tokens");
  assert.equal(tokensLabel(31_200), "~31k tokens");
  assert.equal(tokensLabel(600), "~600 tokens");
  assert.equal(costLabel({ minutes: 12, tokens: 9600 }), "took 12 min and ~9.6k tokens to work out");
  assert.equal(costLabel(undefined), null);
  assert.equal(sectionLead(BODY, "Tried and ruled out"), "Rotating the image before OCR. Works, but doubles latency on long files.");
  assert.equal(sectionLead(BODY, "Missing"), null);
});

// --- finding the notes that bear on a query ---

test("a note shows up for a query that shares its words, or for results in a file it touches", () => {
  const notes = [note(), note({ path: "b.md", title: "Webhook retries back off too fast", body: "## Decided\nUse jitter.", touches: ["internal/hooks/retry.go"] })];
  assert.equal(findNotes(notes, "bbox coordinates rotated pdf")[0]?.note.title, "Bbox coordinates are off on rotated PDFs");
  // Words in common with neither title, but the results land in a file the note touches.
  const byFile = findNotes(notes, "thumbnail crop area", ["internal/ocr/bbox.go"]);
  assert.equal(byFile.length, 1);
  assert.deepEqual(byFile[0]?.shared, ["internal/ocr/bbox.go"]);
});

test("an unrelated note never rides along", () => {
  assert.deepEqual(findNotes([note()], "logging setup for the worker"), []);
  // One stray body word is not enough.
  assert.deepEqual(findNotes([note()], "latency dashboards"), []);
});

test("ask's notes block names the author, the date, each section's lead and the cost", () => {
  const lines = formatNoteHits([{ note: note(), score: 9, shared: [] }]);
  assert.deepEqual(lines, [
    "from Priya's note · Oct 7 · Bbox coordinates are off on rotated PDFs",
    "  decided     Rotate each box in `NormalizeBox` by its own page's `/Rotate` before scaling.",
    "  ruled out   Rotating the image before OCR. Works, but doubles latency on long files.",
    "  watch out   `/Rotate` can be 270 on a single page inside an otherwise upright file.",
    "  .trail/notes/2026-10-07-bbox-priya.md · took 12 min and ~9.6k tokens to work out",
    "",
  ]);
});

// --- what a session cost, from Claude Code's transcript ---

function line(o: object): string {
  return JSON.stringify(o);
}
const at = (min: number) => new Date(Date.parse("2026-10-07T10:00:00Z") + min * 60_000).toISOString();
const usage = (input: number, created: number, output: number, read = 50_000) => ({
  input_tokens: input,
  cache_creation_input_tokens: created,
  cache_read_input_tokens: read,
  output_tokens: output,
});

test("cost counts fresh tokens once per message, and active minutes only", () => {
  const t = [
    line({ type: "user", timestamp: at(0), message: { content: "fix bbox" } }),
    // One message, two content blocks: the usage repeats and must count once.
    line({ type: "assistant", timestamp: at(1), message: { id: "m1", usage: usage(100, 2000, 300), content: [{ type: "text", text: "looking" }] } }),
    line({ type: "assistant", timestamp: at(1), message: { id: "m1", usage: usage(100, 2000, 300), content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "trail ask x" } }] } }),
    // 40 minutes away from the keyboard: not counted.
    line({ type: "assistant", timestamp: at(41), message: { id: "m2", usage: usage(50, 1000, 200), content: [] } }),
  ].join("\n");
  const c = costFromTranscript(t, Date.parse(at(45)));
  assert.equal(c?.tokens, 2400 + 1250);
  assert.equal(c?.minutes, 5, "1 min, then the 40-min gap skipped, then 4 min to now");
});

test("cost starts after the session's last finished note, not the one being written", () => {
  const t = [
    line({ type: "assistant", timestamp: at(0), message: { id: "a", usage: usage(0, 9000, 1000), content: [{ type: "tool_use", id: "n1", name: "Bash", input: { command: "trail note --title first <<'EOF'" } }] } }),
    line({ type: "user", timestamp: at(1), message: { content: [{ type: "tool_result", tool_use_id: "n1", content: "✓ note saved" }] } }),
    line({ type: "assistant", timestamp: at(2), message: { id: "b", usage: usage(10, 400, 90), content: [] } }),
    // The note call in flight now: no result yet, so it is not a boundary.
    line({ type: "assistant", timestamp: at(3), message: { id: "c", usage: usage(0, 0, 100), content: [{ type: "tool_use", id: "n2", name: "Bash", input: { command: "trail note --title second" } }] } }),
  ].join("\n");
  assert.equal(costFromTranscript(t, Date.parse(at(3)))?.tokens, 600);
});

test("no transcript entries, no cost", () => {
  assert.equal(costFromTranscript("", Date.now()), null);
  assert.equal(costFromTranscript("not json\n", Date.now()), null);
});

// --- the block that tells agents about .trail/ ---

test("the Trail block tells an agent to read .trail/, how to install trail, and to leave a note", () => {
  const b = trailBlock("claude");
  assert.match(b, /check `\.trail\/`/);
  assert.match(b, /npm install -g @trailhq\/trail && trail init --agents claude --yes/);
  assert.match(b, /trail note --title/);
  assert.match(trailBlock(), /trail init --yes/);
});

// --- end to end ---

/** Runs from this checkout (so `--import tsx` resolves); the repo goes in `args`. */
function run(name: "trail" | "graft", args: string[], home: string, input?: string) {
  const r = spawnSync(process.execPath, ["--import", "tsx", join(process.cwd(), "src", "bin", `${name}.ts`), ...args], {
    input,
    encoding: "utf8",
    env: { ...process.env, ...homeEnv(home), DO_NOT_TRACK: "1", CLAUDECODE: undefined, TRAIL_INVOKED_AS: undefined },
  });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

function repoWithCode(): string {
  const d = tmpRepo("notes-e2e");
  mkdirSync(join(d, "internal", "ocr"), { recursive: true });
  writeFileSync(join(d, "internal", "ocr", "bbox.go"), "package ocr\n\nfunc NormalizeBox(x float64, rotate int) float64 {\n\treturn x\n}\n");
  writeFileSync(join(d, "CLAUDE.md"), "# extract\n\nTeam rules.\n");
  spawnSync("git", ["init", "-q"], { cwd: d });
  spawnSync("git", ["config", "user.name", "Priya Raman"], { cwd: d });
  spawnSync("git", ["config", "user.email", "p@example.com"], { cwd: d });
  spawnSync("git", ["add", "-A"], { cwd: d });
  spawnSync("git", ["-c", "commit.gpgsign=false", "commit", "-qm", "init"], { cwd: d });
  return d;
}

test("trail init adds .trail/ and the Trail block; graft init adds neither", () => {
  const home = mkdtempSync(join(tmpdir(), "notes-home-"));
  const d = repoWithCode();
  const t = run("trail", ["init", d, "--agents", "claude", "--yes", "--no-global"], home);
  assert.equal(t.status, 0, t.err);
  assert.match(t.err, /✓ \.trail\/ {4}ready · every session you finish leaves a short note here/);
  assert.match(t.err, /✓ CLAUDE\.md {2}Trail block added/);
  assert.ok(existsSync(join(d, ".trail", "README.md")));
  const md = readFileSync(join(d, "CLAUDE.md"), "utf8");
  assert.ok(md.startsWith("# extract\n\nTeam rules.\n"), "the team's own text stays first");
  assert.match(md, /<!-- trail:start -->\n## Trail\n/);

  const g = repoWithCode();
  assert.equal(run("graft", ["init", g, "--agents", "claude", "--yes", "--no-global"], home).status, 0);
  assert.equal(existsSync(join(g, ".trail")), false);
  assert.doesNotMatch(readFileSync(join(g, "CLAUDE.md"), "utf8"), /trail:start/);
});

test("trail note saves the note, ask shows it to the next person, uninstall leaves it", () => {
  const home = mkdtempSync(join(tmpdir(), "notes-home-"));
  const d = repoWithCode();
  run("trail", ["init", d, "--agents", "claude", "--yes", "--no-global"], home);
  // Init's files go in with the setup commit, as they would for a real team.
  spawnSync("git", ["add", "-A"], { cwd: d });
  spawnSync("git", ["-c", "commit.gpgsign=false", "commit", "-qm", "wire trail"], { cwd: d });
  writeFileSync(join(d, "internal", "ocr", "bbox.go"), "package ocr\n\nfunc NormalizeBox(x float64, rotate int) float64 {\n\treturn -x\n}\n");

  const saved = run("trail", ["note", d, "--title", "Bbox coordinates are off on rotated PDFs", "--minutes", "12", "--tokens", "9600"], home, BODY);
  assert.equal(saved.status, 0, saved.err);
  assert.match(saved.out, /^✓ note saved · \.trail\/notes\/\d{4}-\d{2}-\d{2}-bbox-coordinates-are-off-on-rotated-priya\.md$/m);
  assert.match(saved.out, /this took 12 min and ~9\.6k tokens to figure out\. the next person who touches bbox\.go gets it for ~\d+/);
  const [file] = readdirSync(join(d, ".trail", "notes")).filter((f) => f.endsWith(".md"));
  const written = parseNote(readFileSync(join(d, ".trail", "notes", file!), "utf8"), "x");
  assert.equal(written?.author, "Priya");
  assert.deepEqual(written?.touches, ["internal/ocr/bbox.go"], "the changed file, not the wiring init wrote");

  // A teammate still on graft gets the note too.
  for (const name of ["trail", "graft"] as const) {
    const ask = run(name, ["ask", "bbox rotated pdf", d], home);
    assert.equal(ask.status, 0, ask.err);
    assert.match(ask.out, /from Priya's note · \w{3} \d+ · Bbox coordinates are off on rotated PDFs/);
    assert.match(ask.out, /ruled out {3}Rotating the image before OCR/);
  }

  const un = run("trail", ["uninstall", d, "-y", "--no-global"], home);
  assert.equal(un.status, 0, un.err);
  assert.doesNotMatch(readFileSync(join(d, "CLAUDE.md"), "utf8"), /trail:start/);
  assert.ok(existsSync(join(d, ".trail", "notes", file!)), "the team's notes are theirs, never uninstalled");
});

test("trail note without a body says how to write one", () => {
  const home = mkdtempSync(join(tmpdir(), "notes-home-"));
  const r = run("trail", ["note", repoWithCode(), "--title", "x"], home, "");
  assert.equal(r.status, 1);
  assert.match(r.err, /a note needs a --title and a body/);
});

// --- what agents read in a repo that uses trail ---

test("the skill speaks trail in a repo with .trail/, keeps graft/ paths, and teaches notes", async () => {
  const { skillTemplate } = await import("../src/claude/skill-template.js");
  const graft = skillTemplate("graft");
  const trail = skillTemplate("trail");
  assert.equal(skillTemplate(), graft, "graft is the default, unchanged");
  assert.doesNotMatch(graft, /\.trail\//);
  assert.match(trail, /^name: graft$/m, "the name still matches its folder");
  assert.match(trail, /`trail ask "<question>" --source`/);
  assert.match(trail, /`trail build` \/ `trail build --check`/);
  assert.match(trail, /`graft\/` holds a graph/, "the code map folder is still graft/");
  assert.doesNotMatch(trail, /\bgraft (ask|grep|skeleton|callers|map|build|check)\b/);
  assert.match(trail, /trail note --title/);
});

test("the session-start directive mentions notes only where there are some", async () => {
  const { formatOrientation } = await import("../src/claude/format.js");
  assert.doesNotMatch(formatOrientation("# map", 100), /\.trail\//);
  assert.match(formatOrientation("# map", 100, undefined, 3), /Teammates have left 3 notes in \.trail\//);
});

test("hooks speak trail only in a repo that uses it, on a machine with trail installed", async () => {
  const { adoptRepoBrand } = await import("../src/brand.js");
  const bin = mkdtempSync(join(tmpdir(), "notes-bin-"));
  writeFileSync(join(bin, process.platform === "win32" ? "trail.cmd" : "trail"), "");
  const withTrail = tmpRepo("brand-repo");
  ensureTrailDir(withTrail);
  const plain = tmpRepo("brand-plain");
  assert.equal(adoptRepoBrand(withTrail, { PATH: bin }), "trail");
  assert.equal(adoptRepoBrand(withTrail, { PATH: "" }), "graft", "trail not installed: don't suggest it");
  assert.equal(adoptRepoBrand(plain, { PATH: bin }), "graft");
  assert.equal(adoptRepoBrand(plain, { PATH: bin, TRAIL_INVOKED_AS: "trail" }), "trail", "a name already set is kept");
});
