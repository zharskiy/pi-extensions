import { existsSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createFakeAgentRuntime, createFakeHost } from "../../../../../test/framework/index.ts";
import { agentRegistryPlugin } from "../../../api/plugins/agent-registry.ts";
import { pruneAgentRuns } from "../../../core/agent-registry/retention.ts";
import { MANIFEST_FILE } from "../../../core/model/paths.ts";
import { startPlugins, tempDir } from "../../support/subagents-harness.ts";

const DAY_MS = 86_400_000;
const NOW = Date.UTC(2026, 10, 1);
const OLD = NOW - 90 * DAY_MS;
const RECENT = NOW - 5 * DAY_MS;

type Run = { state?: string; endedAt?: number; touched?: number; manifest?: string };

const fabricate = (root = tempDir()) => {
  const sessionsRoot = join(root, "agent", "sessions");
  const slugDir = join(sessionsRoot, "--project--");

  const agentsDir = (stem: string) => join(slugDir, stem, "agents");

  const session = (stem: string) => {
    mkdirSync(slugDir, { recursive: true });
    writeFileSync(join(slugDir, `${stem}.jsonl`), "{}\n");

    return join(slugDir, `${stem}.jsonl`);
  };

  const run = (stem: string, id: string, { state, endedAt, touched = NOW, manifest }: Run = {}) => {
    const dir = join(agentsDir(stem), id);
    const text = manifest ?? (state ? JSON.stringify({ id, state, endedAt }) : undefined);
    const stamp = new Date(touched);

    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "result.md"), "done\n");
    writeFileSync(join(dir, "child.jsonl"), "{}\n");

    if (text !== undefined) {
      writeFileSync(join(dir, MANIFEST_FILE), text);
    }

    readdirSync(dir).forEach((name) => {
      utimesSync(join(dir, name), stamp, stamp);
    });
    utimesSync(dir, stamp, stamp);

    return dir;
  };

  return { root, sessionsRoot, slugDir, agentsDir, session, run };
};

const prune = (sessionsRoot: string, keep: string[] = [], retentionDays = 60) =>
  pruneAgentRuns({ sessionsRoot, retentionDays, keep, now: NOW });

describe("agent run retention", () => {
  it("removes old closed runs and keeps running and recent ones", async () => {
    const layout = fabricate();
    const old = layout.run("s1", "scout-old", { state: "done", endedAt: OLD, touched: OLD });
    const stopped = layout.run("s1", "scout-stopped", { state: "stopped", endedAt: OLD });
    const running = layout.run("s1", "scout-running", { state: "running", touched: OLD });
    const recent = layout.run("s1", "scout-recent", { state: "failed", endedAt: RECENT, touched: OLD });

    await prune(layout.sessionsRoot);

    expect([old, stopped, running, recent].map(existsSync)).toEqual([false, false, true, true]);
  });

  it("judges a run without a readable manifest by its newest file", async () => {
    const layout = fabricate();
    const stale = layout.run("s1", "scout-stale", { touched: OLD });
    const broken = layout.run("s1", "scout-broken", { manifest: "{not json", touched: OLD });
    const fresh = layout.run("s1", "scout-fresh", { touched: OLD });

    utimesSync(join(fresh, "child.jsonl"), new Date(RECENT), new Date(RECENT));

    await prune(layout.sessionsRoot);

    expect([stale, broken, fresh].map(existsSync)).toEqual([false, false, true]);
  });

  it("keeps the protected sessions' runs and pi's own session files", async () => {
    const layout = fabricate();
    const files = ["current", "parent", "other"].map(layout.session);
    const runs = ["current", "parent", "other"].map((stem) =>
      layout.run(stem, "scout-1", { state: "done", endedAt: OLD }),
    );

    await prune(layout.sessionsRoot, [layout.agentsDir("current"), layout.agentsDir("parent")]);

    expect(runs.map(existsSync)).toEqual([true, true, false]);
    expect(files.map(existsSync)).toEqual([true, true, true]);
  });

  it("drops the emptied agents and session directories but not ones still holding runs", async () => {
    const layout = fabricate();

    layout.run("emptied", "scout-1", { state: "done", endedAt: OLD });
    layout.run("partial", "scout-1", { state: "done", endedAt: OLD });
    layout.run("partial", "scout-2", { state: "done", endedAt: RECENT });

    await prune(layout.sessionsRoot);

    expect(readdirSync(layout.slugDir)).toEqual(["partial"]);
    expect(readdirSync(layout.agentsDir("partial"))).toEqual(["scout-2"]);
  });

  it("keeps everything when retentionDays is 0", async () => {
    const layout = fabricate();
    const old = layout.run("s1", "scout-old", { state: "done", endedAt: OLD, touched: OLD });

    await prune(layout.sessionsRoot, [], 0);

    expect(existsSync(old)).toBe(true);
  });

  it("sweeps on session start, sparing the current and parent session", async () => {
    const layout = fabricate();
    const now = Date.now();
    const old = now - 90 * DAY_MS;
    const stale = layout.run("other", "scout-1", { state: "done", endedAt: old });
    const current = layout.run("current", "scout-1", { state: "done", endedAt: old });
    const parent = layout.run("parent", "scout-1", { state: "done", endedAt: old });

    const host = createFakeHost({
      id: basename(layout.root),
      file: layout.session("current"),
      parentSession: layout.session("parent"),
      cwd: join(layout.root, "project"),
      agentDir: join(layout.root, "agent"),
    });

    startPlugins(host, createFakeAgentRuntime([]), [agentRegistryPlugin]);

    await vi.waitFor(() => expect(existsSync(stale)).toBe(false));

    expect([current, parent].map(existsSync)).toEqual([true, true]);
  });
});
