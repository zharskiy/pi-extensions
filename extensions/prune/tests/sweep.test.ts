import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  lutimesSync,
  mkdirSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { chainsOf } from "../core/session-chains.ts";
import { apply, clearEmpties } from "../core/sweep-apply.ts";
import { cutoffAt, type Plan, plan, planAt, scan, totals, within } from "../core/sweep-plan.ts";
import {
  CUTOFF,
  daysAgo,
  fabricate,
  MANIFEST_FILE,
  OLD,
  RECENT,
  runFiles,
  touch,
} from "./support/session-layout.ts";

describe("agent run rules", () => {
  it("removes runs untouched since before the cutoff, whatever their manifest says", async () => {
    const layout = fabricate();
    const old = layout.run("s1", "scout-old", OLD);

    await layout.prune();

    expect(existsSync(old)).toBe(false);
  });

  it("keeps a run with a recently touched file or directory", async () => {
    const layout = fabricate();
    const file = layout.run("s1", "scout-file", OLD);
    const dir = layout.run("s1", "scout-dir", OLD);

    touch(join(file, "child.jsonl"), RECENT);
    touch(dir, RECENT);

    await layout.prune();

    expect([file, dir].map(existsSync)).toEqual([true, true]);
  });

  it("keeps a run exactly at the cutoff", async () => {
    const layout = fabricate();
    const edge = layout.run("s1", "scout-edge", CUTOFF);

    await layout.prune();

    expect(existsSync(edge)).toBe(true);
  });

  it("keeps a fresh session whole, its old runs included", async () => {
    const layout = fabricate();
    const old = layout.run("s1", "scout-old", OLD);
    const file = layout.session("s1", RECENT);

    await layout.prune();

    expect([file, old].map(existsSync)).toEqual([true, true]);
  });

  it("keeps a directory without a manifest", async () => {
    const layout = fabricate();
    const bare = layout.run("s1", "scout-bare", OLD, false);

    await layout.prune();

    expect(existsSync(bare)).toBe(true);
  });

  it("spares a run whose worktree checkout or branch was kept or never released", async () => {
    const layout = fabricate();
    const worktree = { path: "/repo/.pi/worktrees/w", branch: "pi-agents/w", base: "abc", cwd: "/repo" };
    const spared = ["kept", "branch kept", undefined].map((cleanup, index) =>
      layout.run("s1", `worker-${index}`, OLD, { worktree: { ...worktree, cleanup } }),
    );
    const removed = layout.run("s1", "worker-removed", OLD, {
      worktree: { ...worktree, cleanup: "removed" },
    });

    await layout.prune();

    expect(spared.map(existsSync)).toEqual([true, true, true]);
    expect(existsSync(removed)).toBe(false);
  });

  it("treats an unparsable manifest as a plain run", async () => {
    const layout = fabricate();
    const broken = layout.run("s1", "scout-broken", OLD, "{not json");

    await layout.prune();

    expect(existsSync(broken)).toBe(false);
  });

  it("prunes a chain only when every link is past the cutoff", async () => {
    const layout = fabricate();
    const chain = (prefix: string, times: number[]) =>
      times.map((touched, index) =>
        layout.run("s1", `${prefix}-${index}`, touched, {
          predecessorId: index > 0 ? `${prefix}-${index - 1}` : undefined,
          successorId: index < times.length - 1 ? `${prefix}-${index + 1}` : undefined,
        }),
      );
    const tail = chain("tail", [OLD, OLD, RECENT]);
    const head = chain("head", [RECENT, OLD, OLD]);
    const stale = chain("stale", [OLD, OLD, OLD]);

    await layout.prune();

    expect(tail.map(existsSync)).toEqual([true, true, true]);
    expect(head.map(existsSync)).toEqual([true, true, true]);
    expect(stale.map(existsSync)).toEqual([false, false, false]);
  });

  it.skipIf(process.getuid?.() === 0)("keeps a chain whose successor cannot be read", async () => {
    const layout = fabricate();
    const first = layout.run("s1", "worker-1", OLD, { successorId: "worker-2" });
    const second = layout.run("s1", "worker-2", RECENT, { predecessorId: "worker-1" });

    chmodSync(second, 0o000);

    const planned = await layout.planned();

    chmodSync(second, 0o755);

    expect(planned.orphans.stems).toEqual([]);
    expect([first, second].map(existsSync)).toEqual([true, true]);
  });

  it("keeps a chain whose successor has no manifest yet", async () => {
    const layout = fabricate();
    const first = layout.run("s1", "worker-1", OLD, { successorId: "worker-2" });

    layout.run("s1", "worker-2", OLD, false);

    await layout.prune();

    expect(existsSync(first)).toBe(true);
  });

  it("keeps a whole chain when one link spares its worktree", async () => {
    const layout = fabricate();
    const worktree = { path: "/w", branch: "pi-agents/w", base: "abc", cwd: "/w", cleanup: "kept" };
    const first = layout.run("s1", "worker-1", OLD, { successorId: "worker-2" });
    const second = layout.run("s1", "worker-2", OLD, { predecessorId: "worker-1", worktree });

    await layout.prune();

    expect([first, second].map(existsSync)).toEqual([true, true]);
  });

  it("ends a chain at a missing link and survives a cycle", async () => {
    const layout = fabricate();
    const orphan = layout.run("s1", "scout-orphan", OLD, { predecessorId: "gone", successorId: "gone-too" });
    const loop = [
      layout.run("s1", "loop-a", OLD, { predecessorId: "loop-b", successorId: "loop-b" }),
      layout.run("s1", "loop-b", OLD, { predecessorId: "loop-a", successorId: "loop-a" }),
    ];
    const fresh = [
      layout.run("s1", "fresh-a", OLD, { successorId: "fresh-b" }),
      layout.run("s1", "fresh-b", RECENT, { predecessorId: "fresh-a", successorId: "fresh-a" }),
    ];

    await layout.prune();

    expect(existsSync(orphan)).toBe(false);
    expect(loop.map(existsSync)).toEqual([false, false]);
    expect(fresh.map(existsSync)).toEqual([true, true]);
  });

  it("keeps the current and parent sessions with their runs and removes the rest", async () => {
    const layout = fabricate();
    const files = ["current", "parent", "other"].map((stem) => layout.session(stem, OLD));
    const runs = ["current", "parent", "other"].map((stem) => layout.run(stem, "scout-1", OLD));

    await layout.prune({ current: { id: "current", file: files[0], parentSession: files[1] } });

    expect(runs.map(existsSync)).toEqual([true, true, false]);
    expect(files.map(existsSync)).toEqual([true, true, false]);
  });

  it("drops the emptied agents and session directories but not ones still holding runs", async () => {
    const layout = fabricate();

    layout.session("emptied", OLD);
    layout.run("emptied", "scout-1", OLD);
    layout.run("partial", "scout-1", OLD);
    layout.run("partial", "scout-2", RECENT);

    await layout.prune();

    expect(readdirSync(layout.slugDir)).toEqual(["partial"]);
    expect(readdirSync(layout.agentsDir("partial"))).toEqual(["scout-2"]);
  });

  it("touches nothing outside the agents directories", async () => {
    const layout = fabricate();
    const swept = layout.run("s1", "scout-old", OLD);
    const nested = runFiles(join(layout.slugDir, "s1", "other", "x"), "x", OLD);
    const loose = join(layout.agentsDir("s1"), "stray.txt");
    const plain = runFiles(join(layout.slugDir, "plain"), "plain", OLD);

    writeFileSync(loose, "stray\n");
    touch(loose, OLD);

    await layout.prune();

    expect(existsSync(swept)).toBe(false);
    expect([nested, loose, plain].map(existsSync)).toEqual([true, true, true]);
  });

  it("never follows symlinks out of the sessions folder", async () => {
    const layout = fabricate();
    const outside = runFiles(join(layout.root, "outside", "scout-1"), "scout-1", OLD);

    mkdirSync(layout.agentsDir("linked-run"), { recursive: true });
    symlinkSync(outside, join(layout.agentsDir("linked-run"), "scout-1"));
    mkdirSync(join(layout.slugDir, "linked-agents"), { recursive: true });
    symlinkSync(dirname(outside), layout.agentsDir("linked-agents"));

    await layout.prune();

    expect(readdirSync(outside).sort()).toEqual(["child.jsonl", MANIFEST_FILE, "result.md"]);
  });
});

describe("session rules", () => {
  it("removes an old session with its runs, handoff dir and fallback runs", async () => {
    const layout = fabricate();
    const file = layout.session("old", OLD);
    const run = layout.run("old", "scout-1", OLD);
    const handoff = layout.handoff("old", RECENT);

    layout.fallbackRun("old", "scout-2", OLD);

    expect(await layout.prune()).toMatchObject({ sessions: 1, runs: 2, handoffs: 1 });
    expect([file, run, handoff].map(existsSync)).toEqual([false, false, false]);
    expect(readdirSync(layout.slugDir)).toEqual([]);
    expect(readdirSync(join(layout.agentDir, "pi-subagents"))).toEqual([]);
  });

  it("keeps a session a live marker names and removes one whose process is gone", async () => {
    const layout = fabricate();
    const files = ["alive", "dead"].map((stem) => layout.session(stem, OLD));
    const markers = ["alive", "dead"].map((id, index) => layout.marker(id, index + 1));

    await layout.prune({ isAlive: (pid) => pid === 1 });

    expect(files.map(existsSync)).toEqual([true, false]);
    expect(markers.map(existsSync)).toEqual([true, false]);
  });

  it("keeps the files and parents a live marker names", async () => {
    const layout = fabricate();
    const file = layout.session("renamed", OLD);
    const parent = layout.session("parent", OLD);

    layout.marker("other-id", 1, { file, parentSession: parent });

    await layout.prune({ isAlive: () => true });

    expect([file, parent].map(existsSync)).toEqual([true, true]);
  });

  it("never removes a session whose header cannot be read, nor its runs", async () => {
    const layout = fabricate();
    const headerless = layout.unreadable("headerless", `${JSON.stringify({ type: "message" })}\n`);
    const broken = layout.unreadable("broken", "{nope");
    const long = layout.unreadable(
      "long",
      `${JSON.stringify({ type: "session", id: "long", cwd: "x".repeat(64 * 1024) })}\n`,
    );
    const run = layout.run("broken", "scout-1", OLD);

    expect(await layout.prune()).toEqual({ sessions: 0, runs: 0, handoffs: 0, bytes: 0 });
    expect([headerless, broken, long, run].map(existsSync)).toEqual([true, true, true, true]);
  });

  it.skipIf(process.getuid?.() === 0)(
    "aborts the whole sweep when a session file cannot be read",
    async () => {
      const layout = fabricate();
      const old = layout.session("old", OLD);
      const locked = layout.session("locked", OLD);

      chmodSync(locked, 0o000);

      const planned = await layout.planned();

      chmodSync(locked, 0o644);

      expect(planned.aborted).toBe(`${locked}: EACCES`);
      expect(await layout.applied(planned)).toEqual({ sessions: 0, runs: 0, handoffs: 0, bytes: 0 });
      expect(existsSync(old)).toBe(true);
    },
  );

  it("aborts when the live markers folder is a symbolic link", async () => {
    const layout = fabricate();
    const elsewhere = join(layout.root, "elsewhere");

    layout.session("old", OLD);
    mkdirSync(elsewhere);
    mkdirSync(join(layout.agentDir, "pi-prune"), { recursive: true });
    symlinkSync(elsewhere, join(layout.agentDir, "pi-prune", "live"));

    expect((await layout.planned()).aborted).toMatch(/not a readable directory$/);
  });

  it.skipIf(process.getuid?.() === 0)("aborts when the live markers folder cannot be looked at", async () => {
    const layout = fabricate();
    const file = layout.session("resumed", OLD);
    const parent = join(layout.agentDir, "pi-prune");

    layout.marker("resumed", 7);
    chmodSync(parent, 0o000);

    const planned = await layout.planned({ isAlive: (pid) => pid === 7 });

    chmodSync(parent, 0o755);

    expect(planned.aborted).toMatch(/not a readable directory$/);
    expect(planned.chains).toEqual([]);
    expect(existsSync(file)).toBe(true);
  });

  it("ignores symlinked session files and session directories", async () => {
    const layout = fabricate();
    const outside = layout.sessionIn(join(layout.root, "outside"), "linked", OLD);
    const outsideRun = runFiles(join(layout.root, "outside", "linked", "agents", "scout-1"), "scout-1", OLD);

    mkdirSync(layout.slugDir, { recursive: true });
    symlinkSync(outside, join(layout.slugDir, "linked.jsonl"));
    symlinkSync(join(layout.root, "outside", "linked"), join(layout.slugDir, "linked"));

    const planned = await layout.planned();

    expect(planned.chains).toEqual([]);
    expect(planned.orphans.stems).toEqual([]);

    await layout.applied(planned);

    expect([outside, outsideRun].map(existsSync)).toEqual([true, true]);
  });

  it("keeps a session written to after the plan, with its runs and handoff dir", async () => {
    const layout = fabricate();
    const file = layout.session("old", OLD);
    const run = layout.run("old", "scout-1", OLD);
    const handoff = layout.handoff("old", OLD);
    const planned = await layout.planned();

    touch(file, RECENT);

    expect(await layout.applied(planned)).toEqual({ sessions: 0, runs: 0, handoffs: 0, bytes: 0 });
    expect([file, run, handoff].map(existsSync)).toEqual([true, true, true]);
  });

  it("keeps a session a process opened after the plan", async () => {
    const layout = fabricate();
    const file = layout.session("old", OLD);
    const run = layout.run("old", "scout-1", OLD);
    const planned = await layout.planned();

    layout.marker("old", 7);

    expect(await layout.applied(planned, { isAlive: (pid) => pid === 7 })).toEqual({
      sessions: 0,
      runs: 0,
      handoffs: 0,
      bytes: 0,
    });
    expect([file, run].map(existsSync)).toEqual([true, true]);
  });
});

describe("handoff and fallback rules", () => {
  it("removes an orphan handoff dir older than the cutoff and keeps a younger one", async () => {
    const layout = fabricate();
    const old = layout.handoff("gone-old", daysAgo(61));
    const young = layout.handoff("gone-young", daysAgo(59));

    expect(await layout.prune()).toMatchObject({ sessions: 0, runs: 0, handoffs: 1 });
    expect([old, young].map(existsSync)).toEqual([false, true]);
  });

  it("keeps the handoff and fallback dirs of kept and live sessions", async () => {
    const layout = fabricate();

    layout.session("kept", RECENT);

    const handoffs = ["kept", "current-id"].map((id) => layout.handoff(id, OLD));
    const fallbacks = ["kept", "current-id"].map((id) => layout.fallbackRun(id, "scout-1", OLD));

    await layout.prune();

    expect([...handoffs, ...fallbacks].map(existsSync)).toEqual([true, true, true, true]);
  });

  it("does not give a fresh session's handoff dir to an old copy with its id", async () => {
    const layout = fabricate();
    const other = join(layout.sessionsRoot, "--other--");
    const copy = layout.sessionIn(other, "twin", OLD);
    const fresh = layout.session("twin", RECENT);
    const handoff = layout.handoff("twin", OLD);

    expect(await layout.prune({ slugDirs: [layout.slugDir, other] })).toMatchObject({
      sessions: 1,
      runs: 0,
      handoffs: 0,
    });
    expect([copy, fresh, handoff].map(existsSync)).toEqual([false, true, true]);
  });

  it("skips handoff dirs under a root others can write to", async () => {
    const layout = fabricate();
    const file = layout.session("old", OLD);
    const handoffs = [layout.handoff("old", OLD), layout.handoff("gone", OLD)];

    chmodSync(layout.handoffRoot, 0o777);

    const planned = await layout.planned();

    expect(planned.handoffsSkipped).toBe(true);
    expect(await layout.applied(planned)).toMatchObject({ sessions: 1, runs: 0, handoffs: 0 });
    expect([file, ...handoffs].map(existsSync)).toEqual([false, true, true]);
  });

  it("leaves the current session's directory alone before pi writes its file", async () => {
    const layout = fabricate();
    const run = layout.run("current", "scout-1", OLD);

    await layout.prune({ current: { file: join(layout.slugDir, "current.jsonl") } });

    expect(existsSync(run)).toBe(true);
  });
});

const linked = (layout: ReturnType<typeof fabricate>, times: readonly number[], prefix = "s") =>
  times.reduce<string[]>(
    (files, time, index) => files.concat(layout.session(`${prefix}${index}`, time, files.at(-1))),
    [],
  );

describe("session chains", () => {
  it("keeps an old session whose descendant is fresh", async () => {
    const layout = fabricate();
    const files = linked(layout, [OLD, RECENT]);

    await layout.prune();

    expect(files.map(existsSync)).toEqual([true, true]);
  });

  it("keeps an old session whose ancestor is fresh", async () => {
    const layout = fabricate();
    const files = linked(layout, [RECENT, OLD]);

    await layout.prune();

    expect(files.map(existsSync)).toEqual([true, true]);
  });

  it("keeps an old sibling of a fresh session", async () => {
    const layout = fabricate();
    const parent = layout.session("parent", OLD);
    const children = [layout.session("old-child", OLD, parent), layout.session("new-child", RECENT, parent)];

    await layout.prune();

    expect([parent, ...children].map(existsSync)).toEqual([true, true, true]);
  });

  it.each([
    ["ancestor", [RECENT, OLD, OLD]],
    ["descendant", [OLD, OLD, RECENT]],
  ])("keeps a chain whose fresh %s is two links away", async (_side, times) => {
    const layout = fabricate();
    const files = linked(layout, times);

    expect(await layout.prune()).toEqual({ sessions: 0, runs: 0, handoffs: 0, bytes: 0 });
    expect(files.map(existsSync)).toEqual([true, true, true]);
  });

  it("keeps every member of an eight-deep chain with a fresh leaf", async () => {
    const layout = fabricate();
    const files = linked(layout, [...Array.from({ length: 7 }, () => OLD), RECENT]);

    expect((await layout.planned()).chains).toEqual([]);
    expect(await layout.prune()).toEqual({ sessions: 0, runs: 0, handoffs: 0, bytes: 0 });
    expect(files.every(existsSync)).toBe(true);
  });

  it("removes every member of an eight-deep chain when all are old", async () => {
    const layout = fabricate();
    const files = linked(
      layout,
      Array.from({ length: 8 }, () => OLD),
    );

    expect(await layout.prune()).toMatchObject({ sessions: 8, runs: 0, handoffs: 0 });
    expect(files.map(existsSync)).toEqual(Array.from({ length: 8 }, () => false));
  });

  it("removes a cycle of old sessions and keeps it when a middle member is live", async () => {
    const layout = fabricate();
    const first = join(layout.slugDir, "c0.jsonl");
    const cycle = [
      layout.session("c0", OLD, join(layout.slugDir, "c2.jsonl")),
      layout.session("c1", OLD, first),
      layout.session("c2", OLD, join(layout.slugDir, "c1.jsonl")),
    ];

    layout.marker("c1", 7);

    expect(await layout.prune({ isAlive: (pid) => pid === 7 })).toEqual({
      sessions: 0,
      runs: 0,
      handoffs: 0,
      bytes: 0,
    });
    expect(cycle.map(existsSync)).toEqual([true, true, true]);
    expect(await layout.prune()).toMatchObject({ sessions: 3, runs: 0, handoffs: 0 });
    expect(cycle.map(existsSync)).toEqual([false, false, false]);
  });

  it("removes an old session whose parent is itself", async () => {
    const layout = fabricate();
    const file = layout.session("self", OLD, join(layout.slugDir, "self.jsonl"));

    expect(await layout.prune()).toMatchObject({ sessions: 1, runs: 0, handoffs: 0 });
    expect(existsSync(file)).toBe(false);
  });

  it("keeps a chain that spans two slug folders", async () => {
    const layout = fabricate();
    const other = join(layout.sessionsRoot, "--other--");
    const parent = layout.sessionIn(other, "parent", OLD);
    const child = layout.session("child", RECENT, parent);

    await layout.prune({ slugDirs: [layout.slugDir, other] });

    expect([parent, child].map(existsSync)).toEqual([true, true]);
  });

  it("ignores a parent link to a file that was not scanned", async () => {
    const layout = fabricate();
    const outside = layout.sessionIn(join(layout.root, "outside"), "parent", RECENT);
    const child = layout.session("child", OLD, outside);

    await layout.prune();

    expect([outside, child].map(existsSync)).toEqual([true, false]);
  });

  it("keeps an old child whose parent session has no readable header", async () => {
    const layout = fabricate();
    const parent = layout.unreadable("parent", `${JSON.stringify({ type: "message" })}\n`);
    const child = layout.session("child", OLD, parent);

    expect(await layout.prune()).toEqual({ sessions: 0, runs: 0, handoffs: 0, bytes: 0 });
    expect([parent, child].map(existsSync)).toEqual([true, true]);
  });

  it.runIf(process.platform === "darwin")("links a parent path that differs only in case", async () => {
    const layout = fabricate();
    const parent = layout.session("parent", OLD);

    const child = layout.session("child", RECENT, parent.toUpperCase());

    await layout.prune();

    expect([parent, child].map(existsSync)).toEqual([true, true]);
  });

  it("takes an old session's fresh handoff folder with its session", async () => {
    const layout = fabricate();
    const file = layout.session("old", OLD);
    const handoff = layout.handoff("old", RECENT);

    expect(await layout.prune()).toMatchObject({ sessions: 1, runs: 0, handoffs: 1 });
    expect([file, handoff].map(existsSync)).toEqual([false, false]);
  });
});

describe("apply chains", () => {
  it("keeps the whole chain when a member was touched after the plan", async () => {
    const layout = fabricate();
    const files = linked(layout, [OLD, OLD, OLD]);
    const run = layout.run("s0", "scout-1", OLD);
    const handoff = layout.handoff("s0", OLD);
    const planned = await layout.planned();

    touch(files[2], RECENT);

    expect(await layout.applied(planned)).toEqual({ sessions: 0, runs: 0, handoffs: 0, bytes: 0 });
    expect([...files, run, handoff].map(existsSync)).toEqual([true, true, true, true, true]);
  });

  it("keeps the whole chain when a member turned live after the plan", async () => {
    const layout = fabricate();
    const files = linked(layout, [OLD, OLD, OLD]);
    const planned = await layout.planned();

    layout.marker("s2", 7);

    expect(await layout.applied(planned, { isAlive: (pid) => pid === 7 })).toEqual({
      sessions: 0,
      runs: 0,
      handoffs: 0,
      bytes: 0,
    });
    expect(files.map(existsSync)).toEqual([true, true, true]);
  });

  it("stops the rest of the chain when a member turns live during removal", async () => {
    const layout = fabricate();
    const files = linked(layout, [OLD, OLD, OLD]);
    const planned = await layout.planned();

    layout.marker("s1", 7);

    const removed = await layout.applied(planned, { isAlive: (pid) => pid === 7 && !existsSync(files[0]) });

    expect(removed.sessions).toBe(1);
    expect(files.map(existsSync)).toEqual([false, true, true]);
  });

  it("keeps the rest of its chain when a re-check throws", async () => {
    const layout = fabricate();
    const files = linked(layout, [OLD, OLD, OLD]);
    const calls = { count: 0 };

    layout.marker("dead", 9);

    const isAlive = () => {
      calls.count += 1;

      if (calls.count === 4) {
        throw new Error("isAlive failed");
      }

      return false;
    };

    const removed = await layout.prune({ isAlive });

    expect(removed.sessions).toBe(1);
    expect(files.map(existsSync)).toEqual([false, true, true]);
  });

  it("does not stop a chain for a member already gone", async () => {
    const layout = fabricate();
    const files = linked(layout, [OLD, OLD, OLD]);
    const planned = await layout.planned();

    rmSync(files[1]);

    expect(await layout.applied(planned)).toMatchObject({ sessions: 2, runs: 0, handoffs: 0 });
    expect(files.map(existsSync)).toEqual([false, false, false]);
  });
});

describe("one scan, many cutoffs", () => {
  it("plans every cutoff from one scan the same as a fresh plan", async () => {
    const layout = fabricate();

    layout.session("fresh", RECENT);
    layout.fallbackRun("fresh", "scout-1", OLD);
    layout.handoff("fresh", OLD);
    layout.unreadable("headerless", `${JSON.stringify({ type: "message" })}\n`);
    layout.session("month", daysAgo(30));
    layout.run("month", "scout-1", daysAgo(30));
    layout.handoff("month", daysAgo(30));
    layout.session("old", OLD);
    layout.run("old", "scout-1", OLD);
    layout.run("gone", "scout-1", daysAgo(30));
    layout.handoff("orphan", daysAgo(30));

    const input = layout.input();
    const scanned = await scan(input, cutoffAt(input.now, 7));
    const week = await planAt({ ...input, days: 7 });
    const twoMonths = await planAt({ ...input, days: 60 });

    expect(plan(scanned, cutoffAt(input.now, 7))).toEqual(week);
    expect(plan(scanned, cutoffAt(input.now, 60))).toEqual(twoMonths);
    expect([week, twoMonths].map((planned) => planned.chains.length)).toEqual([2, 1]);
  });
});

describe("within", () => {
  it("drops the runs and handoff dirs the confirmed plan did not remove", async () => {
    const layout = fabricate();

    layout.session("old", OLD);
    layout.run("old", "scout-1", OLD);
    layout.run("gone", "scout-1", OLD);
    layout.handoff("orphan", OLD);

    const confirmed = await layout.planned();

    layout.run("old", "scout-2", OLD);
    layout.run("gone", "scout-2", OLD);
    layout.handoff("orphan-2", OLD);

    const fresh = await layout.planned();

    expect(fresh).not.toEqual(confirmed);
    expect(within(fresh, confirmed)).toEqual({ ...confirmed, empties: [] });
  });

  it("drops a session's handoff dir the confirmed plan did not have", async () => {
    const layout = fabricate();
    const old = layout.session("old", OLD);
    const confirmed = await layout.planned();
    const handoff = layout.handoff("old", OLD);
    const fresh = await layout.planned();

    expect(fresh.chains.flat()[0]?.handoff?.dir).toBe(handoff);
    expect(within(fresh, confirmed).chains.flat()).toEqual([
      expect.objectContaining({ file: old, handoff: undefined }),
    ]);
  });

  it("lists no empty handoff dirs, which only the sweep clears", async () => {
    const layout = fabricate();
    const empty = join(layout.handoffRoot, "empty");

    mkdirSync(empty);
    touch(empty, OLD);

    const planned = await layout.planned();

    expect(planned.empties).toEqual([empty]);
    expect(within(planned, planned).empties).toEqual([]);
  });

  it("drops a chain that gained a member after the confirm", async () => {
    const layout = fabricate();
    const files = linked(layout, [OLD, OLD]);
    const other = layout.session("other", OLD);
    const confirmed = await layout.planned();

    layout.session("late", OLD, files[1]);

    const fresh = await layout.planned();

    expect(within(fresh, confirmed).chains.map((chain) => chain.map(({ file }) => file))).toEqual([[other]]);
  });

  it("keeps a chain whose members all match the confirmed plan", async () => {
    const layout = fabricate();

    linked(layout, [OLD, OLD]);

    const confirmed = await layout.planned();

    expect(within(await layout.planned(), confirmed)).toEqual(confirmed);
  });
});

const walked = (path: string): number => {
  const stat = lstatSync(path);

  if (stat.isFile()) {
    return stat.size;
  }

  return stat.isDirectory()
    ? readdirSync(path).reduce((total, name) => total + walked(join(path, name)), 0)
    : 0;
};

const plannedPaths = (planned: Plan) => {
  const sessions = planned.chains.flat();

  return [
    ...sessions.map(({ file }) => file),
    ...[...sessions.flatMap(({ stem }) => stem ?? []), ...planned.orphans.stems].flatMap(({ runs }) =>
      runs.map(({ dir }) => dir),
    ),
    ...[...sessions.flatMap(({ handoff }) => handoff ?? []), ...planned.orphans.handoffs].map(
      ({ dir }) => dir,
    ),
  ];
};

describe("bytes", () => {
  it("plans the bytes of everything apply removes", async () => {
    const layout = fabricate();
    const large = layout.session("large", OLD);

    appendFileSync(large, `${JSON.stringify({ type: "message", text: "x".repeat(5000) })}\n`);
    touch(large, OLD);
    linked(layout, [OLD, OLD], "chain");
    layout.run("large", "scout-1", OLD);
    layout.run("large", "scout-2", OLD);
    writeFileSync(join(layout.handoff("large", OLD), "scout-1-handoff.md"), "y".repeat(300));
    touch(join(layout.handoffRoot, "large", "scout-1-handoff.md"), OLD);
    touch(join(layout.handoffRoot, "large"), OLD);
    layout.run("gone", "scout-1", OLD);
    layout.fallbackRun("nobody", "scout-1", OLD);
    layout.handoff("lost", OLD);
    layout.session("fresh", RECENT);
    layout.run("fresh", "scout-1", OLD);

    const planned = await layout.planned();
    const paths = plannedPaths(planned);
    const walk = paths.reduce((total, path) => total + walked(path), 0);

    expect(walk).toBeGreaterThan(5300);
    expect(totals(planned)).toEqual({ sessions: 3, runs: 4, handoffs: 2, bytes: walk });
    expect(await layout.applied(planned)).toEqual({ sessions: 3, runs: 4, handoffs: 2, bytes: walk });
    expect(paths.filter(existsSync)).toEqual([]);
  });

  it("counts a handoff folder two sessions share once", async () => {
    const layout = fabricate();
    const other = join(layout.sessionsRoot, "--other--");

    layout.sessionIn(other, "twin", OLD);
    layout.session("twin", OLD);

    const handoff = layout.handoff("twin", OLD);
    const planned = await layout.planned({ slugDirs: [layout.slugDir, other] });

    expect(totals(planned)).toMatchObject({ sessions: 2, handoffs: 1 });
    expect(totals(planned).bytes).toBe(
      planned.chains.flat().reduce((total, { file }) => total + lstatSync(file).size, 0) + walked(handoff),
    );
  });

  it.skipIf(process.getuid?.() === 0)("leaves out the bytes apply could not remove", async () => {
    const layout = fabricate();
    const file = layout.session("old", OLD);
    const run = layout.run("old", "scout-1", OLD);
    const size = lstatSync(file).size;

    chmodSync(join(run, ".."), 0o500);

    const removed = await layout.prune();

    chmodSync(join(run, ".."), 0o755);

    expect(removed).toEqual({ sessions: 1, runs: 0, handoffs: 0, bytes: size });
    expect(existsSync(run)).toBe(true);
  });

  it("adds no bytes for a kept chain", async () => {
    const layout = fabricate();
    const files = linked(layout, [OLD, RECENT]);

    layout.run("s0", "scout-1", OLD);
    layout.handoff("s0", OLD);

    const planned = await layout.planned();

    expect(totals(planned)).toEqual({ sessions: 0, runs: 0, handoffs: 0, bytes: 0 });
    expect(files.map(existsSync)).toEqual([true, true]);
  });
});

const emptyDir = (layout: ReturnType<typeof fabricate>, name: string) => {
  const dir = join(layout.handoffRoot, name);

  mkdirSync(dir);
  touch(dir, daysAgo(2));

  return dir;
};

describe("review guards", () => {
  it("does not give an old copy the handoff dir of a newer copy with the same id", async () => {
    const layout = fabricate();
    const other = join(layout.sessionsRoot, "--other--");
    const old = layout.session("dup", daysAgo(400));

    layout.sessionIn(other, "dup", daysAgo(100));

    const handoff = layout.handoff("dup", daysAgo(400));
    const input = layout.input({ slugDirs: [layout.slugDir, other] });
    const scanned = await scan(input, cutoffAt(input.now, 7));
    const planned = plan(scanned, cutoffAt(input.now, 365));

    expect(planned.chains.flat()).toEqual([expect.objectContaining({ file: old, handoff: undefined })]);
    expect(totals(planned).handoffs).toBe(0);
    expect(existsSync(handoff)).toBe(true);
  });

  it("does not measure the handoff dir of an id a fresh copy keeps", async () => {
    const layout = fabricate();
    const other = join(layout.sessionsRoot, "--other--");

    layout.session("dup", daysAgo(400));
    layout.sessionIn(other, "dup", RECENT);
    layout.handoff("dup", daysAgo(400));

    const input = layout.input({ slugDirs: [layout.slugDir, other] });
    const scanned = await scan(input, cutoffAt(input.now, 7));

    expect("owned" in scanned && scanned.owned.has("dup")).toBe(false);
  });

  it("keeps the old parent a live pi names before its own session file exists", async () => {
    const layout = fabricate();
    const parent = layout.session("parent", OLD);

    layout.marker("child", process.pid, { file: join(layout.slugDir, "child.jsonl"), parentSession: parent });

    const planned = await layout.planned({ isAlive: (pid) => pid === process.pid });

    expect(planned.chains).toEqual([]);
  });

  it("stops a chain when a later member changes while an earlier one is removed", async () => {
    const layout = fabricate();
    const files = linked(layout, [OLD, OLD]);

    layout.marker("elsewhere", 999_999);

    const planned = await layout.planned();
    const calls = { count: 0 };

    const isAlive = () => {
      calls.count += 1;

      if (calls.count === 3) {
        files
          .filter((file) => existsSync(file))
          .forEach((file) => {
            touch(file, RECENT);
          });
      }

      return false;
    };

    const removed = await layout.applied(planned, { isAlive });

    expect(removed.sessions).toBe(1);
    expect(files.filter((file) => existsSync(file))).toHaveLength(1);
  });

  it("removes no handoff dir once the root became open to other users", async () => {
    const layout = fabricate();

    layout.session("old", OLD);

    const owned = layout.handoff("old", OLD);
    const orphan = layout.handoff("orphan", OLD);
    const empty = emptyDir(layout, "empty");
    const planned = await layout.planned();

    expect(planned.empties).toContain(empty);

    chmodSync(layout.handoffRoot, 0o777);

    const removed = await apply(planned, layout.input());
    const cleared = await clearEmpties(planned, layout.input());

    chmodSync(layout.handoffRoot, 0o700);

    expect([removed.sessions, removed.handoffs, cleared]).toEqual([1, 0, 0]);
    expect([owned, orphan, empty].map(existsSync)).toEqual([true, true, true]);
  });

  it("lists no symbolic link in the handoff root, as an orphan or an empty dir", async () => {
    const layout = fabricate();
    const target = join(layout.root, "elsewhere");
    const link = join(layout.handoffRoot, "link");

    mkdirSync(target);
    touch(target, OLD);
    symlinkSync(target, link);
    lutimesSync(link, new Date(OLD), new Date(OLD));

    const planned = await layout.planned();

    expect(planned.orphans.handoffs).toEqual([]);
    expect(planned.empties).toEqual([]);
  });

  it("lists no empty dir named after a session live at scan time", async () => {
    const layout = fabricate();
    const live = emptyDir(layout, "live-one");
    const empty = emptyDir(layout, "empty");

    layout.marker("live-one", process.pid);

    const planned = await layout.planned({ isAlive: (pid) => pid === process.pid });

    expect(planned.empties).toEqual([empty]);
    expect(existsSync(live)).toBe(true);
  });

  it("keeps an empty dir whose session turned live after the scan", async () => {
    const layout = fabricate();
    const live = emptyDir(layout, "live-one");
    const empty = emptyDir(layout, "empty");
    const planned = await layout.planned();

    layout.marker("live-one", process.pid);

    const cleared = await clearEmpties(planned, layout.input({ isAlive: (pid) => pid === process.pid }));

    expect(cleared).toBe(1);
    expect([live, empty].map(existsSync)).toEqual([true, false]);
  });
});

describe("long chains", () => {
  it("groups a 20,000-long linear chain whose far end is fresh, so nothing is removable", () => {
    const count = 20_000;
    const members = Array.from({ length: count }, (_, index) => ({
      file: `/sessions/s${index}.jsonl`,
      mtime: index === count - 1 ? RECENT : OLD,
      bytes: 1,
      parent: index === 0 ? undefined : `/sessions/s${index - 1}.jsonl`,
      live: false,
    }));
    const chains = chainsOf(members);

    expect(chains).toHaveLength(1);
    expect(chains[0]?.members).toHaveLength(count);
    expect(chains[0]?.newest).toBe(RECENT);
    expect(chains.filter((chain) => !chain.live && chain.newest < CUTOFF)).toEqual([]);
  });
});
