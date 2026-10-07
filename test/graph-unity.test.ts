/**
 * Unity asset layer (unity.ts, unity-yaml.ts, unity-resolve.ts) over a miniature
 * Unity project (`test/fixtures/unity-mini`): GUIDs from `.meta`, components in
 * scenes/prefabs, nested prefabs and variants, UnityEvents, materials → shaders,
 * Animator controllers, AnimationEvents, Resources/Shader.Find/LoadScene/
 * AssetDatabase strings in code, tags and layers, assembly definitions, the Input
 * System wrapper class, and engine entry points.
 *
 * Each assertion names an edge an agent needs and the breadth tier never had.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildGraph } from "../src/graph/build.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import { checkGraphInvariants } from "../src/graph/invariants.js";
import { resolveSymbol, edgeWalk } from "../src/graph/traverse.js";
import { grepGraph } from "../src/search/grep.js";
import { formatGrepResult } from "../src/search/grep-cli.js";
import { headerOf } from "../src/graph/traverse-cli.js";
import { scanUnityYaml, itemsOf } from "../src/graph/unity-yaml.js";
import { blankInactiveBranches, evalCondition } from "../src/graph/csharp.js";
import { typeName } from "../src/graph/unity-resolve.js";
import type { GraphV1 } from "../src/graph/types.js";
import { tmpRepo } from "./helpers.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "unity-mini");

let cached: GraphV1 | null = null;
let repoDir = "";
async function graph(): Promise<GraphV1> {
  if (cached) return cached;
  const dir = (repoDir = tmpRepo("unity"));
  cpSync(FIXTURE, dir, { recursive: true });
  // a git repo, so Library/ stays out of the index as it does in a real project
  spawnSync("git", ["init", "-q"], { cwd: dir });
  const r = await buildGraph(dir);
  assert.deepEqual(r.errors, []);
  cached = readGraph(wiringPath(r.contextDir))!;
  return cached;
}

const short = (id: string) => id.replace(/^[^#]*#/, "");
function has(g: GraphV1, rel: string, from: string, to: string): boolean {
  return g.edges.some((e) => e.relation === rel && (e.source === from || short(e.source) === from) && (e.target === to || short(e.target) === to));
}
function edgeList(g: GraphV1, rel: string): string {
  return g.edges.filter((e) => e.relation === rel).map((e) => `${short(e.source)} -> ${short(e.target)}`).join("\n");
}

test("UnityYAML scanner: documents, props, refs with paths, list items", () => {
  const text = `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!114 &12
MonoBehaviour:
  m_GameObject: {fileID: 10}
  m_Script: {fileID: 11500000, guid: AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA2, type: 3}
  m_Name:
  spawn: {fileID: 200, guid: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb1, type: 3}
  m_OnClick:
    m_PersistentCalls:
      m_Calls:
      - m_Target: {fileID: 0}
        m_MethodName: OnHit
--- !u!4 &11 stripped
Transform:
  m_PrefabInstance: {fileID: 300}
`;
  const docs = scanUnityYaml(text);
  assert.equal(docs.length, 2);
  assert.equal(docs[0].classId, 114);
  assert.equal(docs[0].type, "MonoBehaviour");
  assert.equal(docs[0].props.m_Script, "{fileID: 11500000, guid: AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA2, type: 3}");
  const spawn = docs[0].refs.find((r) => r.path === "spawn");
  assert.equal(spawn?.guid, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb1", "guids are lower-cased");
  assert.equal(itemsOf(docs[0], "m_Calls")[0].v.m_MethodName, "OnHit");
  assert.equal(docs[1].stripped, true);
  assert.equal(docs[1].start, 13); // 0-based line of its `---` header
});

test("C# #if: inactive branches blank out, keeping lines", () => {
  assert.equal(evalCondition("UNITY_EDITOR && !UNITY_IOS"), true);
  assert.equal(evalCondition("UNITY_2021_3_OR_NEWER || FOO"), true);
  assert.equal(evalCondition("FOO"), false);
  const src = "a\n#if FOO\nb(1,\n#else\nb(2,\n#endif\n3);\n";
  const out = blankInactiveBranches(src);
  assert.equal(out.split("\n").length, src.split("\n").length);
  assert.ok(!out.includes("b(1"), out);
  assert.ok(out.includes("b(2"), out);
});

test("Input System type names follow CSharpCodeHelpers.MakeTypeName", () => {
  assert.equal(typeName("fire"), "Fire");
  assert.equal(typeName("Look Around"), "LookAround");
  assert.equal(typeName("2D Move"), "_2DMove");
});

test("Unity: components in scenes/prefabs attach their classes; prefabs nest and vary", async () => {
  const g = await graph();
  assert.ok(has(g, "attaches", "Walker:Walker", "Walker"), edgeList(g, "attaches"));
  assert.ok(has(g, "attaches", "Spawner:MonoBehaviour", "Spawner"), edgeList(g, "attaches"));
  assert.ok(has(g, "nests", "Assets/Prefabs/Walker.prefab", "Assets/Prefabs/Base.prefab"), edgeList(g, "nests"));
  assert.ok(has(g, "variant_of", "Assets/Prefabs/Variant.prefab", "Assets/Prefabs/Base.prefab"));
  // serialized reference: the scene's spawner field → the prefab's component
  const assign = g.edges.find((e) => e.relation === "assigns" && short(e.source) === "Spawner:MonoBehaviour");
  assert.equal(assign?.target, "Assets/Prefabs/Walker.prefab#Walker:Walker");
  assert.match(assign?.via ?? "", /walkerPrefab/);
  // the component node's span is its own YAML document
  const comp = g.nodes.find((n) => short(n.id) === "Spawner:MonoBehaviour")!;
  assert.equal(comp.kind, "component");
  assert.equal(comp.span, "L18-L26");
  // what it points at rides in the signature, so callers/ask show it without a second hop
  assert.equal(comp.signature, 'Spawner on "Spawner" · walkerPrefab → Assets/Prefabs/Walker.prefab "Walker"');
});

test("Unity: UnityEvent, AnimationEvent and SendMessage reach their methods", async () => {
  const g = await graph();
  const ev = g.edges.find((e) => e.relation === "invokes" && short(e.target) === "Walker.OnHit");
  assert.ok(ev, edgeList(g, "invokes"));
  assert.match(ev!.via ?? "", /m_OnClick/);
  assert.ok(has(g, "invokes", "Assets/Anim/Attack.anim", "Walker.Footstep"), edgeList(g, "invokes"));
  assert.ok(has(g, "invokes", "Spawner.Start", "Walker.Footstep"));
  assert.ok(has(g, "invokes", "Spawner.Start", "Spawner.Later"), "Invoke(nameof(Later))");
});

test("Unity: strings in code resolve to assets, scenes, shaders, parameters, tags, layers", async () => {
  const g = await graph();
  for (const [rel, to] of [
    ["loads", "Assets/Resources/Icons/a.png"], // Resources.Load(IconFolder + "a")
    ["loads", "Assets/Resources/Icons"], // Resources.LoadAll("Icons")
    ["loads", "Assets/Shaders/Glow.shader"], // Shader.Find("Custom/Glow")
    ["loads", "Assets/Scenes/Level.unity"], // SceneManager.LoadScene("Level")
    ["sets", "Parameters/Attack"], // SetTrigger(AttackId), AttackId = StringToHash("Attack")
    ["sets", "Properties/_Glow"], // material.SetFloat("_Glow")
    ["references", "tag:Player"],
    ["references", "layer:Enemy"],
  ] as const) assert.ok(has(g, rel, "Spawner.Start", to), `${rel} → ${to}\n${edgeList(g, rel)}`);
  assert.ok(has(g, "references", "Spawner.AttackId", "Parameters/Attack"), "the hash field references the parameter");
  assert.ok(has(g, "loads", "Builder.BuildStuff", "Assets/Prefabs/Walker.prefab"), "AssetDatabase.LoadAssetAtPath");
  // a texture known only from its .meta becomes an asset node
  const png = g.nodes.find((n) => n.id === "Assets/Resources/Icons/a.png");
  assert.equal(png?.kind, "asset");
});

test("Unity: materials, shaders, includes; controllers, states, behaviours", async () => {
  const g = await graph();
  assert.ok(has(g, "uses_shader", "Assets/Materials/Glow.mat", "Assets/Shaders/Glow.shader"));
  assert.ok(has(g, "assigns", "Assets/Materials/Glow.mat", "Assets/Resources/Icons/a.png"));
  assert.ok(has(g, "imports", "Assets/Shaders/Glow.shader", "Assets/Shaders/Common.hlsl"));
  assert.ok(has(g, "attaches", "Base Layer/Swing", "ZombieSwing"));
  assert.ok(has(g, "assigns", "Base Layer/Swing", "Assets/Anim/Attack.anim"));
  const ctrl = g.nodes.find((n) => n.id === "Assets/Anim/Zombie.controller")!;
  assert.match(ctrl.signature ?? "", /states: Swing/);
  // callers on a shader name and an asset stem
  assert.equal(resolveSymbol(g, "Custom/Glow")[0]?.id, "Assets/Shaders/Glow.shader");
  assert.equal(resolveSymbol(g, "Base")[0]?.id, "Assets/Prefabs/Base.prefab");
  const users = edgeWalk(g, resolveSymbol(g, "Glow.shader")[0], "in", 1).map((h) => h.id);
  assert.ok(users.includes("Assets/Materials/Glow.mat"), users.join(", "));
});

test("Unity: assemblies, input actions, entry points", async () => {
  const g = await graph();
  assert.ok(has(g, "compiles", "Game", "Assets/Scripts/Walker.cs"));
  assert.ok(has(g, "compiles", "Game.Tools", "Assets/Editor/Builder.cs"));
  assert.ok(has(g, "imports", "Game.Tools", "Game"));
  assert.ok(has(g, "compiles", "Assembly-CSharp", "Assets/Input/Controls.cs"));
  assert.ok(has(g, "invokes", "Gameplay/Fire", "Player.OnFire"));
  const fire = g.nodes.find((n) => short(n.id) === "Gameplay/Fire")!;
  assert.match(fire.signature ?? "", /<Mouse>\/leftButton/);
  const entry = (id: string) => g.nodes.find((n) => short(n.id) === id)?.entry ?? "";
  assert.match(entry("Walker.Update"), /Unity message Update/);
  assert.match(entry("Builder.BuildStuff"), /menu "Tools\/Build Stuff"/);
  assert.match(entry("Builder.Run"), /-executeMethod/);
  assert.match(entry("Player.Boot"), /RuntimeInitializeOnLoadMethod/);
  assert.match(entry("Player.LayOut"), /context menu "Lay Out"/);
  assert.match(entry("Walker.OnHit"), /UnityEvent/);
  assert.match(entry("ZombieSwing.OnStateEnter"), /StateMachineBehaviour\.OnStateEnter/);
  assert.equal(entry("Spawner.Later"), "", "a method only code calls is no entry point");
});

test("Unity: a file carries the classes of the prefabs it nests; variants name their base", async () => {
  const g = await graph();
  // Level.unity has no Walker itself, but Walker.prefab nests Base.prefab; the
  // prefab's own carry is Walker → no derived edge; Base carries nothing.
  assert.ok(!g.edges.some((e) => e.relation === "attaches" && e.source === "Assets/Prefabs/Walker.prefab" && short(e.target) === "Walker"), "own components are not re-derived");
  // Level.unity nests Walker.prefab, so it carries Walker too
  const nested = g.edges.find((e) => e.relation === "attaches" && e.source === "Assets/Scenes/Level.unity" && short(e.target) === "Walker");
  assert.ok(nested, edgeList(g, "attaches"));
  assert.match(nested!.via ?? "", /nested prefab Walker\.prefab/);
  const variant = g.nodes.find((n) => n.id === "Assets/Prefabs/Variant.prefab")!;
  assert.match(variant.signature ?? "", /variant .* of Assets\/Prefabs\/Base\.prefab/);
});

test("Unity: package components resolve to foreign nodes; LayerMasks, build indices, tuples", async () => {
  const g = await graph();
  const surface = resolveSymbol(g, "NavMeshSurface")[0];
  assert.equal(surface?.pkg, "com.unity.ai.navigation");
  assert.ok(edgeWalk(g, surface, "in", 1).some((h) => h.node?.path === "Assets/Scenes/Level.unity"), "the scene's component attaches the package class");
  assert.ok(g.edges.some((e) => e.relation === "references" && e.source.startsWith("Assets/Scenes/Level.unity#") && short(e.target) === "layer:Enemy" && /m_LayerMask/.test(e.via ?? "")), edgeList(g, "references"));
  assert.ok(has(g, "loads", "Spawner.Again", "Assets/Scenes/Level.unity"), "LoadSceneAsync(0) → build index 0");
  assert.ok(has(g, "calls", "Spawner.Again", "Walker.Footstep"), "var (w, n) = Pick() types w");
  assert.equal(g.nodes.some((n) => n.path.startsWith("Library/")), false, "package sources are not indexed");
});

test("Unity: grep reports engine entries; callers header says what a constant names", async () => {
  const g = await graph();
  const r = grepGraph(g, repoDir, "Tools/Build Stuff");
  assert.ok(r.entries?.some((e) => e.symbol.name === "Builder.BuildStuff"), JSON.stringify(r.entries));
  assert.match(formatGrepResult(r), /engine entry points matching[\s\S]*BuildStuff · method · Assets\/Editor\/Builder\.cs:L\d+-L\d+ — ⚙ Unity Editor menu "Tools\/Build Stuff"/);
  // `const string LevelScene = "Level"` feeds LoadScene whole: the constant names the scene
  const scene = g.nodes.find((n) => short(n.id) === "Spawner.LevelScene")!;
  assert.equal(scene.names, "Assets/Scenes/Level.unity");
  assert.match(headerOf(scene), /↳ names Assets\/Scenes\/Level\.unity/);
  assert.ok(has(g, "references", "Spawner.LevelScene", "Assets/Scenes/Level.unity"));
  const walker = g.nodes.find((n) => short(n.id) === "Walker")!;
  assert.match(headerOf(walker), /assembly Game \(Assets\/Scripts\/Game\.asmdef\)/);
});

test("Unity: Addressables addresses and AudioMixer exposed parameters", async () => {
  const g = await graph();
  assert.ok(has(g, "loads", "Spawner.Sound", "Assets/Prefabs/Walker.prefab"), `Addressables "Hero" → Walker.prefab\n${edgeList(g, "loads")}`);
  assert.ok(has(g, "sets", "Spawner.Sound", "Exposed/MusicVolume"), edgeList(g, "sets"));
  assert.ok(!has(g, "sets", "Spawner.Sound", "Parameters/Attack"), "a mixer parameter is not an Animator parameter");
});

test("Unity: an incremental build equals a cold one (resolver enrichment never accumulates)", async () => {
  const dir = tmpRepo("unity-inc");
  cpSync(FIXTURE, dir, { recursive: true });
  spawnSync("git", ["init", "-q"], { cwd: dir });
  await buildGraph(dir, { contextDir: join(dir, "graft") });
  const memoKey = () => {
    const cache = join(dir, "graft", ".cache");
    const f = readdirSync(cache).find((x) => x.startsWith("csresolve."));
    return f ? (JSON.parse(readFileSync(join(cache, f), "utf8")) as { key: string }).key : null;
  };
  const key0 = memoKey();
  assert.ok(key0, "the C# edge pass leaves a replay memo");
  const spawner = join(dir, "Assets/Scripts/Spawner.cs");
  const same = async (what: string) => {
    rmSync(join(dir, "cold"), { recursive: true, force: true });
    await buildGraph(dir, { contextDir: join(dir, "cold"), reuse: false });
    const a = readFileSync(wiringPath(join(dir, "graft")), "utf8");
    const b = readFileSync(wiringPath(join(dir, "cold")), "utf8");
    assert.equal(a, b, what);
  };
  // a body edit: declarations unchanged → the other C# files replay their edges
  writeFileSync(spawner, readFileSync(spawner, "utf8").replace("void Later() { }", "void Later() { SendMessage(\"OnHit\"); }"));
  const inc = await buildGraph(dir, { contextDir: join(dir, "graft") });
  assert.ok(inc.reused > 0 && inc.parsed >= 1, `incremental: parsed ${inc.parsed}, reused ${inc.reused}`);
  assert.equal(memoKey(), key0, "a body edit keeps the declaration key (replay path)");
  await same("after a body edit");
  // a declaration edit: everything resolves again
  writeFileSync(spawner, readFileSync(spawner, "utf8").replace("void Later()", "public void Tick() { }\n  void Later()"));
  await buildGraph(dir, { contextDir: join(dir, "graft") });
  assert.notEqual(memoKey(), key0, "a new member changes the declaration key");
  await same("after a declaration edit");
});

test("Unity: graph invariants hold", async () => {
  const g = await graph();
  assert.deepEqual(checkGraphInvariants(g).problems, []);
});
