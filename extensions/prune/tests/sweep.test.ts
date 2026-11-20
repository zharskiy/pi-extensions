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
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { chainsOf } from "../core/session-chains.ts";
import { type Plan, plan, totals, within } from "../core/sweep-plan.ts";
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

const NOTHING = { sessions: 0, runs: 0, handoffs: 0, bytes: 0 };

const oldLink = (target: string, link: string) => {
  symlinkSync(target, link);
  lutimesSync(link, new Date(OLD), new Date(OLD));

  return link;
};

describe("agent run rules", () => {
  it("removes old runs, unparsable manifests too, and keeps fresh, edge and manifestless ones", async () => {
    const layout = fabricate();
    const removed = [layout.run("s1", "scout-old", OLD), layout.run("s1", "scout-broken", OLD, "{not json")];
    const file = layout.run("s1", "scout-file", OLD);
    const dir = layout.run("s1", "scout-dir", OLD);
    const kept = [
      file,
      dir,
      layout.run("s1", "scout-edge", CUTOFF),
      layout.run("s1", "scout-bare", OLD, false),
      layout.session("edge", CUTOFF),
    ];

    touch(join(file, "child.jsonl"), RECENT);
    touch(dir, RECENT);

    await layout.prune();

    expect(removed.map(existsSync)).toEqual([false, false]);
    expect(kept.map(existsSync)).toEqual([true, true, true, true, true]);
  });

  it("keeps a fresh session whole, its old runs included", async () => {
    const layout = fabricate();
    const old = layout.run("s1", "scout-old", OLD);
    const file = layout.session("s1", RECENT);

    await layout.prune();

    expect([file, old].map(existsSync)).toEqual([true, true]);
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

    expect(await layout.applied(planned)).toEqual(NOTHING);
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
    mkdirSync(join(layout.slugDir, "linked-agents"), { recursive: true });

    const links = [
      oldLink(outside, join(layout.agentsDir("linked-run"), "scout-1")),
      oldLink(dirname(outside), layout.agentsDir("linked-agents")),
    ];

    await layout.prune();

    expect(readdirSync(outside).sort()).toEqual(["child.jsonl", MANIFEST_FILE, "result.md"]);
    expect(links.map(existsSync)).toEqual([true, true]);
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

  it("keeps the old parent a live pi names before its own session file exists", async () => {
    const layout = fabricate();
    const parent = layout.session("parent", OLD);

    layout.marker("child", 7, { file: join(layout.slugDir, "child.jsonl"), parentSession: parent });

    expect(await layout.prune({ isAlive: (pid) => pid === 7 })).toEqual(NOTHING);
    expect(existsSync(parent)).toBe(true);
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

    expect(await layout.prune()).toEqual(NOTHING);
    expect([headerless, broken, long, run].map(existsSync)).toEqual([true, true, true, true]);
  });

  it.skipIf(process.getuid?.() === 0)(
    "aborts the whole sweep when a session file cannot be read",
    async () => {
      const layout = fabricate();
      const old = layout.session("old", OLD);
      const locked = layout.session("locked", OLD);

      chmodSync(locked, 0o000);

      const aborted = await layout.aborted();

      chmodSync(locked, 0o644);

      expect(aborted).toBe(`${locked}: EACCES`);
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

    expect(await layout.aborted()).toMatch(/not a readable directory$/);
  });

  it.skipIf(process.getuid?.() === 0)("aborts when the live markers folder cannot be looked at", async () => {
    const layout = fabricate();
    const file = layout.session("resumed", OLD);
    const parent = join(layout.agentDir, "pi-prune");

    layout.marker("resumed", 7);
    chmodSync(parent, 0o000);

    const aborted = await layout.aborted({ isAlive: (pid) => pid === 7 });

    chmodSync(parent, 0o755);

    expect(aborted).toMatch(/not a readable directory$/);
    expect(existsSync(file)).toBe(true);
  });

  it("ignores symlinked session files and session directories", async () => {
    const layout = fabricate();
    const outside = layout.sessionIn(join(layout.root, "outside"), "linked", OLD);
    const outsideRun = runFiles(join(layout.root, "outside", "linked", "agents", "scout-1"), "scout-1", OLD);

    mkdirSync(layout.slugDir, { recursive: true });

    const links = [
      oldLink(outside, join(layout.slugDir, "linked.jsonl")),
      oldLink(join(layout.root, "outside", "linked"), join(layout.slugDir, "linked")),
    ];

    expect(await layout.prune()).toEqual(NOTHING);
    expect([outside, outsideRun, ...links].map(existsSync)).toEqual([true, true, true, true]);
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

  it.each([
    ["a fresh copy", OLD, RECENT, 60, 60],
    ["a newer copy, planned from an earlier scan", daysAgo(400), daysAgo(100), 7, 365],
  ])(
    "does not give an old copy the handoff dir of %s with its id",
    async (_case, old, newer, scanDays, days) => {
      const layout = fabricate();
      const copy = layout.sessionIn(join(layout.sessionsRoot, "--other--"), "twin", old);
      const kept = layout.session("twin", newer);
      const handoff = layout.handoff("twin", old);
      const scanned = await layout.scanned({ days: scanDays });

      expect(await layout.applied(plan(scanned, daysAgo(days)))).toMatchObject({ sessions: 1, handoffs: 0 });
      expect([copy, kept, handoff].map(existsSync)).toEqual([false, true, true]);
    },
  );

  it("skips handoff dirs, empty ones too, under a root others can write to", async () => {
    const layout = fabricate();
    const file = layout.session("old", OLD);
    const kept = [layout.handoff("old", OLD), layout.handoff("gone", OLD), layout.empty("empty")];

    chmodSync(layout.handoffRoot, 0o777);

    expect(await layout.swept()).toMatchObject({ removed: { sessions: 1, handoffs: 0 }, empties: 0 });
    expect([file, ...kept].map(existsSync)).toEqual([false, true, true, true]);
  });

  it("leaves the current session's directory alone before pi writes its file", async () => {
    const layout = fabricate();
    const run = layout.run("current", "scout-1", OLD);

    await layout.prune({ current: { file: join(layout.slugDir, "current.jsonl") } });

    expect(existsSync(run)).toBe(true);
  });
});

describe("empty handoff folders", () => {
  it.each([
    [
      "a folder with a file",
      (layout: ReturnType<typeof fabricate>) => {
        const file = join(layout.empty("full"), "main-handoff.md");

        writeFileSync(file, "handoff\n");
        touch(file, daysAgo(2));
        touch(dirname(file), daysAgo(2));

        return [file];
      },
    ],
    [
      "an empty folder younger than a day",
      (layout: ReturnType<typeof fabricate>) => [layout.empty("young", daysAgo(0.5))],
    ],
    [
      "an empty folder named after a live id",
      (layout: ReturnType<typeof fabricate>) => {
        layout.marker("live-one", 7);

        return [layout.empty("live-one")];
      },
    ],
    [
      "a symbolic link to an empty folder",
      (layout: ReturnType<typeof fabricate>) => {
        const target = join(layout.root, "elsewhere");
        const link = join(layout.handoffRoot, "link");

        mkdirSync(target);
        touch(target, daysAgo(2));
        symlinkSync(target, link);
        lutimesSync(link, new Date(daysAgo(2)), new Date(daysAgo(2)));

        return [target, link];
      },
    ],
    [
      "a plain file",
      (layout: ReturnType<typeof fabricate>) => {
        const file = join(layout.handoffRoot, "plain");

        writeFileSync(file, "");
        touch(file, daysAgo(2));

        return [file];
      },
    ],
  ])("clears an empty folder older than a day and keeps %s", async (_case, arrange) => {
    const layout = fabricate();
    const empty = layout.empty("empty");
    const kept = arrange(layout);

    expect(await layout.swept({ isAlive: (pid) => pid === 7 })).toEqual({ removed: NOTHING, empties: 1 });
    expect(existsSync(empty)).toBe(false);
    expect(kept.filter((path) => !existsSync(path))).toEqual([]);
  });
});

const linked = (layout: ReturnType<typeof fabricate>, times: readonly number[], prefix = "s") =>
  times.reduce<string[]>(
    (files, time, index) => files.concat(layout.session(`${prefix}${index}`, time, files.at(-1))),
    [],
  );

describe("session chains", () => {
  it.each([
    ["descendant", [OLD, RECENT]],
    ["ancestor", [RECENT, OLD]],
    ["ancestor two links away", [RECENT, OLD, OLD]],
    ["descendant two links away", [OLD, OLD, RECENT]],
    ["leaf eight deep", [...Array.from({ length: 7 }, () => OLD), RECENT]],
  ])("keeps a chain whose fresh member is its %s", async (_side, times) => {
    const layout = fabricate();
    const files = linked(layout, times);

    layout.run("s0", "scout-1", OLD);
    layout.handoff("s0", OLD);

    expect(await layout.prune()).toEqual(NOTHING);
    expect(files.filter((file) => !existsSync(file))).toEqual([]);
  });

  it("keeps an old sibling of a fresh session", async () => {
    const layout = fabricate();
    const parent = layout.session("parent", OLD);
    const children = [layout.session("old-child", OLD, parent), layout.session("new-child", RECENT, parent)];

    await layout.prune();

    expect([parent, ...children].map(existsSync)).toEqual([true, true, true]);
  });

  it("removes an all-old eight-deep chain and an old session whose parent is itself", async () => {
    const layout = fabricate();
    const files = linked(
      layout,
      Array.from({ length: 8 }, () => OLD),
    );
    const self = layout.session("self", OLD, join(layout.slugDir, "self.jsonl"));

    expect(await layout.prune()).toMatchObject({ sessions: 9, runs: 0, handoffs: 0 });
    expect([...files, self].filter(existsSync)).toEqual([]);
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

    expect(await layout.prune({ isAlive: (pid) => pid === 7 })).toEqual(NOTHING);
    expect(cycle.map(existsSync)).toEqual([true, true, true]);
    expect(await layout.prune()).toMatchObject({ sessions: 3, runs: 0, handoffs: 0 });
    expect(cycle.map(existsSync)).toEqual([false, false, false]);
  });

  it("keeps a chain that spans two slug folders", async () => {
    const layout = fabricate();
    const other = join(layout.sessionsRoot, "--other--");
    const parent = layout.sessionIn(other, "parent", OLD);
    const child = layout.session("child", RECENT, parent);

    await layout.prune();

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

    expect(await layout.prune()).toEqual(NOTHING);
    expect([parent, child].map(existsSync)).toEqual([true, true]);
  });

  it.runIf(process.platform === "darwin")("links a parent path that differs only in case", async () => {
    const layout = fabricate();
    const parent = layout.session("parent", OLD);

    const child = layout.session("child", RECENT, parent.toUpperCase());

    await layout.prune();

    expect([parent, child].map(existsSync)).toEqual([true, true]);
  });
});

describe("apply chains", () => {
  it.each([
    [
      "a member was touched after the plan",
      (files: string[]) => {
        touch(files[2] ?? "", RECENT);

        return () => false;
      },
    ],
    [
      "a member turned live after the plan",
      (_files: string[], layout: ReturnType<typeof fabricate>) => {
        layout.marker("s2", 7);

        return (pid: number) => pid === 7;
      },
    ],
    [
      "the liveness check throws before removal starts",
      (_files: string[], layout: ReturnType<typeof fabricate>) => {
        layout.marker("dead", 9);

        return () => {
          throw new Error("isAlive failed");
        };
      },
    ],
  ])("keeps the whole chain when %s", async (_case, change) => {
    const layout = fabricate();
    const files = linked(layout, [OLD, OLD, OLD]);
    const kept = [...files, layout.run("s0", "scout-1", OLD), layout.handoff("s0", OLD)];
    const planned = await layout.planned();
    const isAlive = change(files, layout);

    expect(await layout.applied(planned, { isAlive })).toEqual(NOTHING);
    expect(kept.filter((path) => !existsSync(path))).toEqual([]);
  });

  it("stops a chain at the first failed unlink", async () => {
    const layout = fabricate();

    const runs = linked(layout, [OLD, OLD, OLD]).map((file) =>
      layout.run(basename(file, ".jsonl"), "scout-1", OLD),
    );
    const planned = await layout.planned();
    const [first, failing, last] = planned.chains[0];

    rmSync(failing.file);
    mkdirSync(failing.file);
    touch(failing.file, OLD);

    expect(await layout.applied(planned)).toMatchObject({ sessions: 1, runs: 1, handoffs: 0 });
    expect([first, failing, last].map(({ file }) => existsSync(file))).toEqual([false, true, true]);
    expect(runs.filter(existsSync)).toHaveLength(2);
  });

  it("stops a chain at a member already gone", async () => {
    const layout = fabricate();

    linked(layout, [OLD, OLD, OLD]);

    const planned = await layout.planned();
    const [first, gone, last] = planned.chains[0].map(({ file }) => file);

    rmSync(gone);

    expect(await layout.applied(planned)).toMatchObject({ sessions: 1, runs: 0, handoffs: 0 });
    expect([first, last].map(existsSync)).toEqual([false, true]);
  });
});

describe("one scan, many cutoffs", () => {
  it("plans every cutoff from one scan the same as a fresh plan", async () => {
    const layout = fabricate();

    layout.session("fresh", RECENT);
    layout.fallbackRun("fresh", "scout-1", OLD);
    layout.fallbackRun("month", "scout-2", OLD);
    layout.handoff("fresh", OLD);
    layout.unreadable("headerless", `${JSON.stringify({ type: "message" })}\n`);
    layout.session("month", daysAgo(30));
    layout.run("month", "scout-1", daysAgo(30));
    layout.handoff("month", daysAgo(30));
    layout.session("old", OLD);
    layout.run("old", "scout-1", OLD);
    layout.run("gone", "scout-1", daysAgo(30));
    layout.handoff("orphan", daysAgo(30));

    const scanned = await layout.scanned({ days: 7 });
    const week = await layout.planned({ days: 7 });
    const twoMonths = await layout.planned({ days: 60 });

    expect(plan(scanned, daysAgo(7))).toEqual(week);
    expect(plan(scanned, daysAgo(60))).toEqual(twoMonths);
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
    expect(within(fresh, confirmed)).toEqual(confirmed);
  });

  it("drops a session's handoff dir the confirmed plan did not have", async () => {
    const layout = fabricate();
    const old = layout.session("old", OLD);
    const confirmed = await layout.planned();
    const handoff = layout.handoff("old", OLD);
    const fresh = await layout.planned();

    expect(totals(fresh).handoffs).toBe(1);
    expect(await layout.applied(within(fresh, confirmed))).toMatchObject({ sessions: 1, handoffs: 0 });
    expect([old, handoff].map(existsSync)).toEqual([false, true]);
  });

  it("drops a chain that gained a member after the confirm", async () => {
    const layout = fabricate();
    const files = linked(layout, [OLD, OLD]);
    const other = layout.session("other", OLD);
    const confirmed = await layout.planned();

    const late = layout.session("late", OLD, files[1]);
    const fresh = await layout.planned();

    expect(await layout.applied(within(fresh, confirmed))).toMatchObject({ sessions: 1 });
    expect([...files, late, other].map(existsSync)).toEqual([true, true, true, false]);
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
    ...[...sessions.flatMap(({ runs }) => runs), ...planned.orphans.runs].map(({ dir }) => dir),
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

    const files = [layout.sessionIn(other, "twin", OLD), layout.session("twin", OLD)];
    const handoff = layout.handoff("twin", OLD);
    const bytes = files.reduce((total, file) => total + walked(file), walked(handoff));

    expect(totals(await layout.planned())).toEqual({ sessions: 2, runs: 0, handoffs: 1, bytes });
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
