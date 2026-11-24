import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createBus } from "../../../../../platform/extension-manager/index.ts";
import { createRegistry } from "../../../core/agent-registry/registry.ts";
import { listSections, visibleRecords } from "../../../core/agent-view/list-model.ts";
import {
  type AgentRecord,
  type AgentRegistry,
  chainLinks,
  MAIN_CALLER,
} from "../../../core/model/agent-record.ts";
import type { BusEvents } from "../../../core/model/events.ts";
import { pastRecords } from "../../../core/model/manifest.ts";
import { MANIFEST_FILE } from "../../../core/model/paths.ts";
import { agentRecord } from "../../support/agent-records.ts";
import { tempDir } from "../../support/subagents-harness.ts";

const newAgent = (dir: string) => ({
  agent: "scout",
  task: "search",
  description: "search",
  callerId: MAIN_CALLER,
  depth: 2,
  batchId: "b-1",
  dir,
  contextLimit: 100_000,
});

describe("agent registry", () => {
  it("records a failed manifest write in error and still emits every event", () => {
    const bus = createBus<BusEvents>();
    const events: string[] = [];

    bus.on("agent:changed", (record) => events.push(`changed ${record.state}`));
    bus.on("agent:closed", (record) => events.push(`closed ${record.state}`));

    const registry = createRegistry({
      bus,
      handoffPath: (id) => `/tmp/${id}-handoff.md`,
      writeManifest: () => {
        throw new Error("disk full");
      },
    });

    const record = registry.create(newAgent(tempDir()));

    registry.update(record.id, { state: "running" });
    registry.close(record.id, { state: "done" });

    expect(registry.get(record.id)).toMatchObject({
      state: "done",
      error: "manifest not written: disk full",
    });
    expect(events).toEqual(["changed queued", "changed running", "changed done", "closed done"]);
  });

  it("skips an id whose directory already exists from an earlier run of the session", () => {
    const dir = tempDir();
    const ids = ["scout-aaaa", "scout-aaaa", "scout-bbbb"];

    mkdirSync(join(dir, "scout-aaaa"));

    const registry = createRegistry({
      bus: createBus<BusEvents>(),
      handoffPath: (id) => `/tmp/${id}-handoff.md`,
      newId: () => ids.shift() ?? "",
    });

    expect(registry.create(newAgent(dir)).id).toBe("scout-bbbb");
  });

  it("draws agent ids from six random bytes", () => {
    const registry = createRegistry({
      bus: createBus<BusEvents>(),
      handoffPath: (id) => `/tmp/${id}-handoff.md`,
      writeManifest: () => {},
    });

    expect(registry.create(newAgent(tempDir())).id).toMatch(/^scout-[0-9a-f]{12}$/);
  });

  it("writes the final turns, tool calls, tokens and context to the manifest on close", () => {
    const registry = createRegistry({
      bus: createBus<BusEvents>(),
      handoffPath: (id) => `/tmp/${id}-handoff.md`,
    });
    const record = registry.create(newAgent(tempDir()));

    registry.update(record.id, { state: "running" });
    const context = { tokens: 21_000, window: 200_000, percent: 10.5 };

    registry.update(record.id, { turns: 3, toolCalls: 4, tokens: 12_300, context });
    registry.close(record.id, { state: "done" });

    const manifest = JSON.parse(readFileSync(join(record.dir, MANIFEST_FILE), "utf8"));

    expect(manifest).toMatchObject({ turns: 3, toolCalls: 4, tokens: 12_300, context, state: "done" });
  });

  it("writes the manifest without creating the handoff folder", () => {
    const handoffDir = join(tempDir(), "pi-handoff");
    const registry = createRegistry({
      bus: createBus<BusEvents>(),
      handoffPath: (id) => join(handoffDir, `${id}-handoff.md`),
    });
    const record = registry.create(newAgent(tempDir()));

    registry.update(record.id, { state: "running" });
    registry.close(record.id, { state: "done" });

    expect(existsSync(join(record.dir, MANIFEST_FILE))).toBe(true);
    expect(existsSync(handoffDir)).toBe(false);
  });

  it("keeps each turn's context in the manifest, so a restore after a hard kill has the latest figure", () => {
    const registry = createRegistry({
      bus: createBus<BusEvents>(),
      handoffPath: (id) => `/tmp/${id}-handoff.md`,
    });
    const agentsDir = tempDir();
    const record = registry.create(newAgent(agentsDir));
    const latest = { tokens: 64_000, window: 200_000, percent: 32 };

    registry.update(record.id, { state: "running" });
    registry.update(record.id, { context: { tokens: 21_000, window: 200_000, percent: 10.5 } });
    registry.update(record.id, { context: latest });

    const restored = pastRecords(agentsDir, (dir) => ({
      dir,
      handoffPath: "/tmp/handoff.md",
      contextLimit: 100_000,
    }));

    expect(restored.find((past) => past.id === record.id)?.context).toEqual(latest);
  });

  describe("restoring damaged chain links", () => {
    const done = (id: string, createdAt: number, patch: Partial<AgentRecord> = {}) =>
      agentRecord({ id, state: "done", createdAt, endedAt: 1_000 + createdAt, ...patch });

    const restored = (...batches: AgentRecord[][]) => {
      const registry = createRegistry({ bus: createBus<BusEvents>(), handoffPath: (id) => `/tmp/${id}.md` });

      batches.forEach((batch) => {
        registry.restore(batch);
      });

      return registry;
    };

    const listedIds = (registry: AgentRegistry) =>
      listSections(visibleRecords(registry.list(), new Set()))
        .flatMap((section) => section.rows.flatMap((row) => chainLinks(registry, row.record)))
        .map((record) => record.id)
        .sort();

    const links = (registry: AgentRegistry, id: string) => {
      const record = registry.get(id);

      return { predecessorId: record?.predecessorId, successorId: record?.successorId };
    };

    it("cuts a predecessor or successor cycle into one chain and lists each record once", () => {
      const registry = restored([
        done("x", 1, { predecessorId: "y" }),
        done("y", 2, { predecessorId: "x" }),
        done("c", 3, { successorId: "d" }),
        done("d", 4, { successorId: "c" }),
        done("k", 5, { callerId: "c" }),
      ]);

      expect(links(registry, "x")).toEqual({ predecessorId: "y", successorId: undefined });
      expect(links(registry, "y")).toEqual({ predecessorId: undefined, successorId: "x" });
      expect(links(registry, "c")).toEqual({ predecessorId: "d", successorId: undefined });
      expect(links(registry, "d")).toEqual({ predecessorId: undefined, successorId: "c" });
      expect(listedIds(registry)).toEqual(["c", "d", "k", "x", "y"]);
    });

    it("pairs a one-sided link and drops one that the other end contradicts", () => {
      const registry = restored([
        done("old", 1),
        done("new", 2, { predecessorId: "old" }),
        done("taken", 3, { predecessorId: "old" }),
      ]);

      expect(links(registry, "old")).toEqual({ predecessorId: undefined, successorId: "new" });
      expect(links(registry, "new")).toEqual({ predecessorId: "old", successorId: undefined });
      expect(links(registry, "taken")).toEqual({ predecessorId: undefined, successorId: undefined });
      expect(listedIds(registry)).toEqual(["new", "old", "taken"]);
    });

    it("drops the caller link that closes a caller cycle and hides no child", () => {
      const registry = restored([
        done("p", 1, { callerId: "q" }),
        done("q", 2, { callerId: "p" }),
        done("s", 3, { callerId: "s" }),
        done("child", 4, { callerId: "q" }),
      ]);

      expect(registry.get("p")?.callerId).toBe(MAIN_CALLER);
      expect(registry.get("q")?.callerId).toBe("p");
      expect(registry.get("s")?.callerId).toBe(MAIN_CALLER);
      expect(listedIds(registry)).toEqual(["child", "p", "q", "s"]);
    });

    it("breaks a cycle that spans two restores and keeps intact chains and dangling links", () => {
      const registry = restored(
        [
          done("a", 1, { successorId: "b" }),
          done("m", 3, { successorId: "n" }),
          done("n", 4, { predecessorId: "m" }),
        ],
        [done("b", 2, { successorId: "a" }), done("lost", 5, { successorId: "gone" })],
      );

      expect(links(registry, "a")).toEqual({ predecessorId: "b", successorId: undefined });
      expect(links(registry, "b")).toEqual({ predecessorId: undefined, successorId: "a" });
      expect(links(registry, "n")).toEqual({ predecessorId: "m", successorId: undefined });
      expect(links(registry, "lost")).toEqual({ predecessorId: undefined, successorId: "gone" });
      expect(listedIds(registry)).toEqual(["a", "b", "lost", "m", "n"]);
    });
  });
});
