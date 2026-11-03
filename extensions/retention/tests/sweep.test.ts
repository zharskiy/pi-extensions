import { chmodSync, existsSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
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

    expect(await layout.prune()).toEqual({ sessions: 1, runs: 2, handoffs: 1 });
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

    const planned = await layout.planned({ isAlive: () => true });

    expect(planned.kept).toEqual([
      { file: parent, reason: "live" },
      { file, reason: "live" },
    ]);
  });

  it("keeps the parent of a kept session but not its grandparent", async () => {
    const layout = fabricate();
    const grandparent = layout.session("grandparent", OLD);
    const parent = layout.session("parent", OLD, grandparent);
    const child = layout.session("child", RECENT, parent);

    const planned = await layout.planned();

    expect(planned.kept).toEqual([
      { file: child, reason: "fresh" },
      { file: parent, reason: "parent" },
    ]);
    expect(planned.sessions.map((session) => session.file)).toEqual([grandparent]);
  });

  it.runIf(process.platform === "darwin")("matches a parent whose path differs in case", async () => {
    const layout = fabricate();
    const parent = layout.session("parent", OLD);

    layout.session("child", RECENT, parent.toUpperCase());

    const planned = await layout.planned();

    expect(planned.kept.map((session) => session.reason)).toEqual(["fresh", "parent"]);
  });

  it("never removes a session whose header cannot be read, nor its runs, and reports it", async () => {
    const layout = fabricate();
    const headerless = layout.unreadable("headerless", `${JSON.stringify({ type: "message" })}\n`);
    const broken = layout.unreadable("broken", "{nope");
    const long = layout.unreadable(
      "long",
      `${JSON.stringify({ type: "session", id: "long", cwd: "x".repeat(64 * 1024) })}\n`,
    );
    const run = layout.run("broken", "scout-1", OLD);

    const planned = await layout.planned();

    expect(planned.unreadable.sort()).toEqual([broken, headerless, long]);

    await layout.applied(planned);

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
      expect(await layout.applied(planned)).toEqual({ sessions: 0, runs: 0, handoffs: 0 });
      expect(existsSync(old)).toBe(true);
    },
  );

  it("aborts when the live markers folder is a symbolic link", async () => {
    const layout = fabricate();
    const elsewhere = join(layout.root, "elsewhere");

    layout.session("old", OLD);
    mkdirSync(elsewhere);
    mkdirSync(join(layout.agentDir, "pi-retention"), { recursive: true });
    symlinkSync(elsewhere, join(layout.agentDir, "pi-retention", "live"));

    expect((await layout.planned()).aborted).toMatch(/not a readable directory$/);
  });

  it.skipIf(process.getuid?.() === 0)("aborts when the live markers folder cannot be looked at", async () => {
    const layout = fabricate();
    const file = layout.session("resumed", OLD);
    const parent = join(layout.agentDir, "pi-retention");

    layout.marker("resumed", 7);
    chmodSync(parent, 0o000);

    const planned = await layout.planned({ isAlive: (pid) => pid === 7 });

    chmodSync(parent, 0o755);

    expect(planned.aborted).toMatch(/not a readable directory$/);
    expect(planned.sessions).toEqual([]);
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

    expect(planned.sessions).toEqual([]);
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

    expect(await layout.applied(planned)).toEqual({ sessions: 0, runs: 0, handoffs: 0 });
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
    });
    expect([file, run].map(existsSync)).toEqual([true, true]);
  });
});

describe("handoff and fallback rules", () => {
  it("removes an orphan handoff dir older than the cutoff and keeps a younger one", async () => {
    const layout = fabricate();
    const old = layout.handoff("gone-old", daysAgo(61));
    const young = layout.handoff("gone-young", daysAgo(59));

    expect(await layout.prune()).toEqual({ sessions: 0, runs: 0, handoffs: 1 });
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

  it("skips handoff dirs under a root others can write to", async () => {
    const layout = fabricate();
    const file = layout.session("old", OLD);
    const handoffs = [layout.handoff("old", OLD), layout.handoff("gone", OLD)];

    chmodSync(layout.handoffRoot, 0o777);

    const planned = await layout.planned();

    expect(planned.handoffsSkipped).toBe(true);
    expect(await layout.applied(planned)).toEqual({ sessions: 1, runs: 0, handoffs: 0 });
    expect([file, ...handoffs].map(existsSync)).toEqual([false, true, true]);
  });

  it("leaves the current session's directory alone before pi writes its file", async () => {
    const layout = fabricate();
    const run = layout.run("current", "scout-1", OLD);

    await layout.prune({ current: { file: join(layout.slugDir, "current.jsonl") } });

    expect(existsSync(run)).toBe(true);
  });
});
