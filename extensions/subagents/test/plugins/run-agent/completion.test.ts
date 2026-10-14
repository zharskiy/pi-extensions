import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThemeLike } from "../../../../../core/adapter/contract.ts";
import { flush, plainTheme } from "../../../../../core/test/helpers/fakes.ts";
import type { AgentRecord, NewAgent } from "../../../src/model/types.ts";
import { agentDefinitionsPlugin } from "../../../src/plugins/agent-definitions/index.ts";
import { agentRegistryPlugin } from "../../../src/plugins/agent-registry/index.ts";
import {
  CLOSED_ENTRY,
  type ClosedEntry,
  renderClosedEntry,
} from "../../../src/plugins/run-agent/completion.ts";
import { runAgentPlugin } from "../../../src/plugins/run-agent/index.ts";
import type { RunAgentDetails, RunAgentParams } from "../../../src/plugins/run-agent/tools.ts";
import { createHarness, tempDir } from "../../helpers/harness.ts";

const setup = () => {
  const harness = createHarness([agentRegistryPlugin, agentDefinitionsPlugin, runAgentPlugin]);
  const registry = harness.services.require("registry");
  const closedEntries = () =>
    harness.host.entries
      .filter((entry) => entry.customType === CLOSED_ENTRY)
      .map((entry) => entry.data as ClosedEntry);

  const create = (patch: Partial<NewAgent> = {}) =>
    registry.create({
      agent: "explorer",
      description: "Map the auth module",
      callerId: "main",
      depth: 2,
      batchId: "b-1",
      dir: tempDir(),
      contextLimit: 100_000,
      ...patch,
    });

  const close = (record: AgentRecord, patch: Partial<AgentRecord> & { state: AgentRecord["state"] }) => {
    registry.update(record.id, { startedAt: 0 });
    vi.setSystemTime(patch.endedAt ?? 65_000);

    return registry.close(record.id, patch);
  };

  return { ...harness, registry, closedEntries, create, close };
};

const entry = (patch: Partial<ClosedEntry>): ClosedEntry => ({
  v: 1,
  id: "explorer-1",
  agent: "explorer",
  description: "Map the auth module",
  state: "done",
  durationMs: 65_000,
  ...patch,
});

const tokenTheme: ThemeLike = { fg: (token, text) => `<${token}>${text}`, bold: (text) => text };

afterEach(() => {
  vi.useRealTimers();
});

describe("completion lines", () => {
  it("appends one dim line when a main-session agent finishes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(0);

    const harness = setup();
    const runAgent = harness.host.tool<RunAgentParams, RunAgentDetails>("run_agent");

    harness.host.idle = false;
    await runAgent.execute(
      { agents: [{ agent: "explorer", task: "map", description: "Map the auth module" }] },
      { update: () => {} },
    );
    await flush();
    vi.setSystemTime(65_000);
    harness.runtime.children[0].finish("mapped");

    const entries = harness.closedEntries();

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ v: 1, state: "done", durationMs: 65_000 });
    expect(harness.host.renderEntry(CLOSED_ENTRY, entries[0])).toEqual([
      '✓ Agent "Map the auth module" finished · 1m 5s',
    ]);
  });

  it("renders failed, stopped and handed off lines with their glyphs", () => {
    expect(
      renderClosedEntry(
        entry({
          state: "failed",
          description: "Fix the login redirect",
          error: "tests failed twice",
          durationMs: 130_000,
        }),
        plainTheme,
      ),
    ).toEqual(['✗ Agent "Fix the login redirect" failed: tests failed twice · 2m 10s']);
    expect(
      renderClosedEntry(
        entry({ state: "stopped", description: "Review the diff of PR 5", durationMs: 182_000 }),
        plainTheme,
      ),
    ).toEqual(['■ Agent "Review the diff of PR 5" was stopped · 3m 2s']);
    expect(
      renderClosedEntry(entry({ state: "handoff", durationMs: 3_720_000, sessions: 2 }), plainTheme),
    ).toEqual(['↪ Agent "Map the auth module" handed off · 1h 2m · 2 sessions']);
    expect(renderClosedEntry(entry({}), tokenTheme)?.[0]).toMatch(/^<dim>/);
    expect(renderClosedEntry(entry({ state: "failed", error: "x" }), tokenTheme)?.[0]).toMatch(/^<error>/);
    expect(renderClosedEntry(entry({ state: "stopped" }), tokenTheme)?.[0]).toMatch(/^<warning>/);
    expect(renderClosedEntry(entry({ state: "handoff" }), tokenTheme)?.[0]).toMatch(/^<warning>/);
  });

  it("cuts the description at 60 and the error at 120 columns", () => {
    const [line] =
      renderClosedEntry(
        entry({ state: "failed", description: "d".repeat(80), error: "e".repeat(200) }),
        plainTheme,
      ) ?? [];

    expect(line).toBe(`✗ Agent "${"d".repeat(59)}…" failed: ${"e".repeat(119)}… · 1m 5s`);
  });

  it("prints nothing for children of agents", () => {
    vi.useFakeTimers({ toFake: ["Date"] });

    const harness = setup();
    const caller = harness.create();
    const child = harness.create({ callerId: caller.id, depth: 3 });

    harness.close(child, { state: "done" });

    expect(harness.closedEntries()).toEqual([]);
  });

  it("prints once at the end of a chain with the session count", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(0);

    const harness = setup();
    const first = harness.create();
    const second = harness.create({ chainIndex: 2, predecessorId: first.id });

    harness.close(first, { state: "handoff", successorId: second.id, endedAt: 30_000 });

    expect(harness.closedEntries()).toEqual([]);

    harness.registry.update(second.id, { startedAt: 30_000 });
    vi.setSystemTime(65_000);
    harness.registry.close(second.id, { state: "done" });

    const entries = harness.closedEntries();

    expect(entries).toHaveLength(1);
    expect(harness.host.renderEntry(CLOSED_ENTRY, entries[0])).toEqual([
      '✓ Agent "Map the auth module" finished · 1m 5s · 2 sessions',
    ]);
  });

  it("waits for the worktree cleanup and names the outcome", () => {
    vi.useFakeTimers({ toFake: ["Date"] });

    const harness = setup();
    const worktree = { path: "/w", branch: "pi-agents/explorer-1", base: "abc", cwd: "/w" };
    const removed = harness.create({ worktree });
    const kept = harness.create({ worktree });

    harness.close(removed, { state: "done", endedAt: 3_000 });

    expect(harness.closedEntries()).toEqual([]);

    harness.registry.update(removed.id, { worktree: { ...worktree, cleanup: "removed" } });

    expect(harness.host.renderEntry(CLOSED_ENTRY, harness.closedEntries()[0])).toEqual([
      '✓ Agent "Map the auth module" finished · 3s · worktree removed',
    ]);

    harness.close(kept, { state: "done", endedAt: 3_000 });
    harness.registry.update(kept.id, { worktree: { ...worktree, cleanup: "branch kept" } });
    harness.registry.update(kept.id, { worktree: { ...worktree, cleanup: "kept" } });

    expect(harness.closedEntries()).toHaveLength(2);
    expect(harness.host.renderEntry(CLOSED_ENTRY, harness.closedEntries()[1])).toEqual([
      '✓ Agent "Map the auth module" finished · 3s · branch pi-agents/explorer-1 kept',
    ]);
  });

  it("prints no line for a worktree cleanup that finishes after shutdown started", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });

    const harness = setup();
    const worktree = { path: "/w", branch: "pi-agents/explorer-1", base: "abc", cwd: "/w" };
    const record = harness.create({ worktree });

    harness.close(record, { state: "done", endedAt: 3_000 });
    await harness.host.shutdown("new");
    harness.registry.update(record.id, { worktree: { ...worktree, cleanup: "removed" } });

    expect(harness.closedEntries()).toEqual([]);
  });

  it("hides entries of an unknown version", () => {
    expect(setup().host.renderEntry(CLOSED_ENTRY, { v: 2 })).toBeUndefined();
  });

  it("prints no line for agents interrupted by a session switch", async () => {
    const harness = setup();
    const runAgent = harness.host.tool<RunAgentParams, RunAgentDetails>("run_agent");

    harness.host.idle = false;
    await runAgent.execute({ agents: [{ agent: "explorer", task: "map" }] }, { update: () => {} });
    await flush();
    await harness.host.shutdown("new");

    expect(harness.registry.list()[0]).toMatchObject({ state: "failed", error: "interrupted: session new" });
    expect(harness.closedEntries()).toEqual([]);
  });
});
