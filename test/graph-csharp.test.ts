/**
 * C# depth tier (csharp.ts + csharp-resolve.ts): scope-aware extraction and typed
 * resolution across files. Each fixture repo is tiny and built through the real
 * pipeline (`buildGraph`), so cache, resolver and graph shape are all exercised.
 *
 * The cases pin what the breadth tier could not do: a member call on a field /
 * local / `var` / `GetComponent<T>()` / foreach variable resolving to the one
 * right `Tick` among many, heritage through namespaces and `using`s, partial
 * classes spread over files, extension methods, events, overrides.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildGraph } from "../src/graph/build.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import { checkGraphInvariants } from "../src/graph/invariants.js";
import type { GraphV1 } from "../src/graph/types.js";
import { tmpRepo } from "./helpers.js";

async function build(files: Record<string, string>): Promise<{ graph: GraphV1; dir: string }> {
  const dir = tmpRepo("cs");
  for (const [rel, src] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), src);
  }
  const r = await buildGraph(dir);
  const graph = readGraph(wiringPath(r.contextDir))!;
  return { graph, dir };
}

function edges(g: GraphV1, rel: string): string[] {
  const short = (id: string) => id.replace(/^[^#]*#/, "");
  return g.edges.filter((e) => e.relation === rel).map((e) => `${short(e.source)} -> ${short(e.target)}`).sort();
}

const WALKER = `using UnityEngine;
namespace Game.Enemies
{
    public sealed partial class Walker : MonoBehaviour, IDamageable
    {
        public void Tick(float dt) { }
        void Update() { Tick(Time.deltaTime); }
        public void Damage(float amount) { Died?.Invoke(this); }
        public event System.Action<Walker> Died;
    }
}
`;
const WALKER_PART = `namespace Game.Enemies
{
    public partial class Walker
    {
        public int Hp { get; private set; }
        public void Heal() { Hp = 10; Tick(0f); }
    }
}
`;
const OTHER_TICKS = `namespace Game.Other
{
    public class Turret { public void Tick(float dt) { } }
    public class Crate { public void Tick(float dt) { } }
}
`;
const IDAMAGEABLE = `namespace Game
{
    public interface IDamageable { void Damage(float amount); }
}
`;
const SPAWNER = `using System.Collections.Generic;
using System.Linq;
using UnityEngine;
using Game.Enemies;
namespace Game.Spawning
{
    public class Spawner : MonoBehaviour
    {
        [SerializeField] private Walker prefab;
        private readonly List<Walker> live = new List<Walker>();
        private Dictionary<string, Walker> byName = new();
        public Walker Last => live.Last();

        void FixedUpdate()
        {
            foreach (var w in live) w.Tick(1f);
            var first = live.FirstOrDefault();
            first.Heal();
            live.ForEach(x => x.Damage(1f));
            if (byName.TryGetValue("a", out var named)) named.Tick(2f);
            var c = GetComponent<Walker>();
            c.Tick(3f);
            var spawned = Instantiate(prefab);
            spawned.Heal();
            Last.Heal();
            prefab.Died += OnDied;
            prefab.Bump();
        }
        void OnDied(Walker w) { }
    }
    public static class WalkerExt { public static void Bump(this Walker w) { w.Tick(4f); } }
}
`;
const HITTER = `namespace Game
{
    public class Hitter
    {
        public void Hit(IDamageable d) { d.Damage(5f); }
        public void Hit2(Game.Enemies.Walker w) { w.Damage(6f); }
    }
}
`;

test("C#: typed member calls pick the right Tick among same-named methods", async () => {
  const { graph } = await build({
    "Assets/Walker.cs": WALKER,
    "Assets/Walker.Health.cs": WALKER_PART,
    "Assets/Other.cs": OTHER_TICKS,
    "Assets/IDamageable.cs": IDAMAGEABLE,
    "Assets/Spawner.cs": SPAWNER,
    "Assets/Hitter.cs": HITTER,
  });
  const calls = edges(graph, "calls");
  // implicit this, across partial declarations
  assert.ok(calls.includes("Walker.Update -> Walker.Tick"), calls.join("\n"));
  assert.ok(calls.includes("Walker.Heal -> Walker.Tick"), "partial class member calls the other part's method");
  // foreach over List<Walker>, LINQ element, dictionary out var, GetComponent<T>, Instantiate(prefab), property, extension
  for (const want of [
    "Spawner.FixedUpdate -> Walker.Tick",
    "Spawner.FixedUpdate -> Walker.Heal",
    "Spawner.FixedUpdate -> Walker.Damage",
    "Spawner.FixedUpdate -> WalkerExt.Bump",
    "WalkerExt.Bump -> Walker.Tick",
  ]) assert.ok(calls.includes(want), `missing ${want}\n${calls.join("\n")}`);
  // never the other classes' Tick
  assert.ok(!calls.some((c) => c.endsWith("Turret.Tick") || c.endsWith("Crate.Tick")), calls.join("\n"));
  // interface call dispatches to the implementation too
  assert.ok(calls.includes("Hitter.Hit -> IDamageable.Damage"));
  assert.ok(calls.includes("Hitter.Hit -> Walker.Damage"));
  assert.ok(calls.includes("Hitter.Hit2 -> Walker.Damage"));
});

test("C#: heritage through namespaces, partials, events, overrides", async () => {
  const { graph } = await build({
    "Assets/Walker.cs": WALKER,
    "Assets/Walker.Health.cs": WALKER_PART,
    "Assets/IDamageable.cs": IDAMAGEABLE,
    "Assets/Spawner.cs": SPAWNER,
  });
  const impl = edges(graph, "implements");
  assert.ok(impl.includes("Walker -> IDamageable"), impl.join("\n"));
  const ext = graph.edges.filter((e) => e.relation === "extends").map((e) => e.target);
  assert.ok(ext.includes("UnityEngine.MonoBehaviour"), `external base named by FQN: ${ext.join(", ")}`);
  const subs = graph.edges.filter((e) => e.relation === "subscribes");
  assert.equal(subs.length, 1);
  assert.match(subs[0].target, /Spawner\.OnDied$/);
  assert.equal(subs[0].via, "prefab.Died");
  assert.ok(edges(graph, "references").includes("WalkerExt.Bump -> Walker"), "an extension method hangs on the type it extends");
  const ov = edges(graph, "overrides");
  assert.ok(ov.includes("Walker.Damage -> IDamageable.Damage"), ov.join("\n"));
  const refs = edges(graph, "references");
  assert.ok(refs.includes("Walker.Heal -> Walker.Hp"), "property write is a reference");
  assert.ok(refs.includes("Spawner.FixedUpdate -> Walker.Died"), "event subscription references the event");
  const inv = checkGraphInvariants(graph);
  assert.deepEqual(inv.problems, []);
});

test("C#: `using static` imports nested types; GetComponent<T> on an untyped receiver is still T", async () => {
  const { graph } = await build({
    "Assets/UiFactory.cs": `namespace Game.UI
{
    public static partial class UiFactory
    {
        public static class UiSound { public static void Denied() { } }
    }
}
`,
    "Assets/Screen.cs": `using static Game.UI.UiFactory;
namespace Game.UI
{
    public class Screen
    {
        void Close(object o) { UiSound.Denied(); var w = Unknown(o).GetComponent<Screen>(); w.Close(o); }
    }
}
`,
  });
  const calls = edges(graph, "calls");
  assert.ok(calls.includes("Screen.Close -> UiFactory.UiSound.Denied"), calls.join("\n"));
  assert.ok(calls.includes("Screen.Close -> Screen.Close"), "recursion through GetComponent<Screen>() on an unknown receiver");
});

test("callers: tests that reach a method through one call are listed", async () => {
  const { graph } = await build({
    "Assets/Walker.cs": WALKER,
    "Assets/IDamageable.cs": IDAMAGEABLE,
    "Assets/Hitter.cs": HITTER,
    "Assets/Tests/HitterTests.cs": `using NUnit.Framework;
namespace Game.Tests
{
    public class HitterTests
    {
        [Test]
        public void Hit_Damages() { new Hitter().Hit2(null); }
    }
}
`,
  });
  const { indirectTests } = await import("../src/graph/traverse-cli.js");
  const { edgeWalk } = await import("../src/graph/traverse.js");
  const damage = graph.nodes.find((n) => n.id === "Assets/Walker.cs#Game.Enemies.Walker.Damage" || n.id.endsWith("#Walker.Damage"))!;
  const lines = indirectTests(graph, damage, edgeWalk(graph, damage, "in", 1));
  assert.ok(lines.some((l) => /test → Hit2 ← Hit_Damages \(Assets\/Tests\/HitterTests\.cs:L\d+-L\d+\)/.test(l)), lines.join("\n"));
  const entry = graph.nodes.find((n) => n.name === "Hit_Damages")?.entry ?? "";
  assert.match(entry, /NUnit test \[Test\]/);
});
