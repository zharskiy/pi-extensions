import { existsSync, mkdirSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createFakeAgentRuntime, createFakeHost } from "../../../../../test/framework/index.ts";
import { agentRegistryPlugin } from "../../../api/plugins/agent-registry.ts";
import { pruneAgentRuns } from "../../../core/agent-registry/retention.ts";
import { MANIFEST_FILE } from "../../../core/model/paths.ts";
import { startPlugins, tempDir } from "../../support/subagents-harness.ts";

const DAY_MS = 86_400_000;
const NOW = Math.floor(Date.now() / 1000) * 1000;
const daysAgo = (days: number) => NOW - days * DAY_MS;
const OLD = daysAgo(90);
const RECENT = daysAgo(5);
const CUTOFF = daysAgo(60);

const touch = (path: string, time: number) => {
  utimesSync(path, new Date(time), new Date(time));
};

type Manifest = Record<string, unknown> | string | false;

const manifestText = (id: string, manifest: Record<string, unknown> | string) =>
  typeof manifest === "string" ? manifest : JSON.stringify({ id, state: "running", ...manifest });

const runFiles = (dir: string, id: string, touched: number, manifest: Manifest = {}) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "result.md"), "done\n");
  writeFileSync(join(dir, "child.jsonl"), "{}\n");

  if (manifest !== false) {
    writeFileSync(join(dir, MANIFEST_FILE), manifestText(id, manifest));
  }

  readdirSync(dir).forEach((name) => {
    touch(join(dir, name), touched);
  });
  touch(dir, touched);

  return dir;
};

const fabricate = () => {
  const root = tempDir();
  const agentDir = join(root, "agent");
  const sessionsRoot = join(agentDir, "sessions");
  const slugDir = join(sessionsRoot, "--project--");

  const agentsDir = (stem: string) => join(slugDir, stem, "agents");

  const session = (stem: string, touched = NOW) => {
    const file = join(slugDir, `${stem}.jsonl`);

    mkdirSync(slugDir, { recursive: true });
    writeFileSync(file, "{}\n");
    touch(file, touched);

    return file;
  };

  const run = (stem: string, id: string, touched = NOW, manifest: Manifest = {}) =>
    runFiles(join(agentsDir(stem), id), id, touched, manifest);

  const prune = (keepSessions: string[] = [], retentionDays = 60) =>
    pruneAgentRuns({ sessionsRoot, retentionDays, keepSessions, now: NOW });

  return { root, agentDir, sessionsRoot, slugDir, agentsDir, session, run, prune };
};

describe("agent run retention", () => {
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

  it("keeps old runs while their session file is recent", async () => {
    const layout = fabricate();
    const old = layout.run("s1", "scout-old", OLD);

    layout.session("s1", RECENT);

    await layout.prune();

    expect(existsSync(old)).toBe(true);
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

  it("keeps the protected sessions' runs and pi's own session files", async () => {
    const layout = fabricate();
    const files = ["current", "parent", "other"].map((stem) => layout.session(stem, OLD));
    const runs = ["current", "parent", "other"].map((stem) => layout.run(stem, "scout-1", OLD));

    await layout.prune(files.slice(0, 2));

    expect(runs.map(existsSync)).toEqual([true, true, false]);
    expect(files.map(existsSync)).toEqual([true, true, true]);
  });

  it("drops the emptied agents and session directories but not ones still holding runs", async () => {
    const layout = fabricate();

    layout.session("emptied", OLD);
    layout.run("emptied", "scout-1", OLD);
    layout.run("partial", "scout-1", OLD);
    layout.run("partial", "scout-2", RECENT);

    await layout.prune();

    expect(readdirSync(layout.slugDir).sort()).toEqual(["emptied.jsonl", "partial"]);
    expect(readdirSync(layout.agentsDir("partial"))).toEqual(["scout-2"]);
  });

  it("touches nothing outside the session agents directories", async () => {
    const layout = fabricate();
    const swept = layout.run("s1", "scout-old", OLD);
    const nested = runFiles(join(layout.slugDir, "s1", "other", "x"), "x", OLD);
    const loose = join(layout.agentsDir("s1"), "stray.txt");
    const plain = runFiles(join(layout.slugDir, "plain"), "plain", OLD);
    const fallback = runFiles(
      join(layout.agentDir, "pi-subagents", "id-1", "agents", "scout-1"),
      "scout-1",
      OLD,
    );

    writeFileSync(loose, "stray\n");
    touch(loose, OLD);

    await layout.prune();

    expect(existsSync(swept)).toBe(false);
    expect([nested, loose, plain, fallback].map(existsSync)).toEqual([true, true, true, true]);
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

  it("keeps everything when retentionDays is 0", async () => {
    const layout = fabricate();
    const old = layout.run("s1", "scout-old", OLD);

    await layout.prune([], 0);

    expect(existsSync(old)).toBe(true);
  });

  it("sweeps on session start with the configured retention, sparing the current and parent session", async () => {
    const layout = fabricate();

    layout.run("ninety", "scout-1", daysAgo(90));
    layout.run("ancient", "scout-1", daysAgo(200));
    layout.run("current", "scout-1", daysAgo(200));
    layout.run("parent", "scout-1", daysAgo(200));

    const host = createFakeHost({
      id: basename(layout.root),
      file: layout.session("current", daysAgo(200)),
      parentSession: layout.session("parent", daysAgo(200)),
      cwd: join(layout.root, "project"),
      agentDir: layout.agentDir,
    });

    startPlugins(host, createFakeAgentRuntime([]), [agentRegistryPlugin], { retentionDays: 100 });

    await vi.waitFor(() =>
      expect(readdirSync(layout.slugDir).sort()).toEqual([
        "current",
        "current.jsonl",
        "ninety",
        "parent",
        "parent.jsonl",
      ]),
    );
  });
});
