import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { INTERVALS } from "../core/command-args.ts";
import { cutoffAt, plan, planAt, scan } from "../core/sweep-plan.ts";
import { daysAgo, fabricate, OLD, RECENT, touch } from "./support/session-layout.ts";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();

  return { ...actual, readdir: vi.fn(actual.readdir) };
});

const WEEK = 7;

const readPaths = () => vi.mocked(readdir).mock.calls.map(([path]) => String(path));

const touchedAt = (dir: string) =>
  Math.max(lstatSync(dir).mtimeMs, ...readdirSync(dir).map((name) => lstatSync(join(dir, name)).mtimeMs));

const naiveOrphans = (root: string, claimed: ReadonlySet<string>, cutoff: number) =>
  readdirSync(root)
    .filter((name) => !claimed.has(name))
    .map((name) => join(root, name))
    .filter((dir) => lstatSync(dir).isDirectory() && touchedAt(dir) < cutoff)
    .sort();

describe("handoff shortcuts", () => {
  it("keeps a fresh handoff folder with an old document without reading it", async () => {
    const layout = fabricate();
    const young = layout.handoff("young", OLD);
    const old = layout.handoff("old", OLD);

    touch(young, RECENT);
    vi.mocked(readdir).mockClear();

    await layout.prune();

    expect([young, old].map(existsSync)).toEqual([true, false]);
    expect(readPaths()).toContain(old);
    expect(readPaths()).not.toContain(young);
  });

  it("keeps an old handoff folder with a fresh document", async () => {
    const layout = fabricate();
    const rewritten = layout.handoff("rewritten", OLD);

    touch(join(rewritten, "main-handoff.md"), RECENT);

    await layout.prune();

    expect(existsSync(rewritten)).toBe(true);
  });

  it("removes an old handoff folder with old documents", async () => {
    const layout = fabricate();
    const old = layout.handoff("old", OLD);

    expect(await layout.prune()).toEqual({ sessions: 0, runs: 0, handoffs: 1 });
    expect(existsSync(old)).toBe(false);
  });

  it("keeps a handoff folder whose mtime equals the latest cutoff at every interval", async () => {
    const layout = fabricate();
    const input = layout.input();
    const edge = layout.handoff("edge", cutoffAt(input.now, WEEK));
    const scanned = await scan(input, cutoffAt(input.now, WEEK));

    expect(INTERVALS.flatMap((days) => plan(scanned, cutoffAt(input.now, days)).orphans.handoffs)).toEqual(
      [],
    );
    expect(existsSync(edge)).toBe(true);
  });

  it("never plans a symbolic link or a plain file in the handoff root", async () => {
    const layout = fabricate();
    const target = join(layout.root, "target");
    const link = join(layout.handoffRoot, "linked");
    const file = join(layout.handoffRoot, "plain");

    mkdirSync(target);
    touch(target, OLD);
    symlinkSync(target, link);
    writeFileSync(file, "x");
    touch(file, OLD);

    expect((await layout.planned()).orphans.handoffs).toEqual([]);
    expect([target, file].map(existsSync)).toEqual([true, true]);
  });

  it("plans from one scan the same as fresh scans and a naive reference at every interval", async () => {
    const layout = fabricate();
    const input = layout.input({ isAlive: (pid) => pid === 7 });

    layout.session("fresh", RECENT);
    layout.handoff("fresh", OLD);
    layout.fallbackRun("fresh", "scout-1", OLD);
    layout.session("month", daysAgo(30));
    layout.run("month", "scout-1", daysAgo(30));
    layout.handoff("month", daysAgo(30));
    layout.session("old", OLD);
    layout.run("old", "scout-1", OLD);
    layout.handoff("old", RECENT);
    layout.marker("live-id", 7);
    layout.handoff("live-id", OLD);
    layout.run("gone", "scout-1", daysAgo(30));
    layout.fallbackRun("nobody", "scout-1", daysAgo(100));
    layout.unreadable("headerless", `${JSON.stringify({ type: "message" })}\n`);
    layout.handoff("headerless", daysAgo(200));
    layout.handoff("edge", cutoffAt(input.now, WEEK));
    touch(join(layout.handoff("rewritten", OLD), "main-handoff.md"), RECENT);
    touch(layout.handoff("young", OLD), RECENT);
    [3, 10, 45, 100, 400].forEach((days) => {
      layout.handoff(`orphan-${days}`, daysAgo(days));
    });

    const claimed = new Set(["fresh", "month", "old", "live-id", "current-id"]);
    const scanned = await scan(input, cutoffAt(input.now, WEEK));

    const checks = await Promise.all(
      INTERVALS.map(async (days) => {
        const cutoff = cutoffAt(input.now, days);
        const fromScan = plan(scanned, cutoff);

        return {
          same: fromScan,
          fresh: await planAt({ ...input, days }),
          handoffs: [...fromScan.orphans.handoffs].sort(),
          naive: naiveOrphans(layout.handoffRoot, claimed, cutoff),
        };
      }),
    );

    checks.forEach((check) => {
      expect(check.same).toEqual(check.fresh);
      expect(check.handoffs).toEqual(check.naive);
    });
    expect(checks.map((check) => check.handoffs.length)).toEqual([5, 4, 3, 3, 2, 1]);
  });

  it("throws for a cutoff after the scan's latest cutoff", async () => {
    const layout = fabricate();
    const input = layout.input();
    const scanned = await scan(input, cutoffAt(input.now, 60));

    expect(() => plan(scanned, cutoffAt(input.now, WEEK))).toThrow(
      "plan: cutoff after the scan's latest cutoff",
    );
  });

  it.skipIf(process.getuid?.() === 0)(
    "keeps a handoff folder it cannot read and plans the rest",
    async () => {
      const layout = fabricate();
      const locked = layout.handoff("locked", OLD);
      const open = layout.handoff("open", OLD);

      chmodSync(locked, 0o000);

      const removed = await layout.prune();

      chmodSync(locked, 0o755);

      expect(removed.handoffs).toBe(1);
      expect([locked, open].map(existsSync)).toEqual([true, false]);
    },
  );
});
