import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createBus } from "../../../../../extension-manager/index.ts";
import { createRegistry } from "../../../core/agent-registry/registry.ts";
import { MAIN_CALLER } from "../../../core/model/agent-record.ts";
import type { BusEvents } from "../../../core/model/events.ts";
import { MANIFEST_FILE } from "../../../core/model/paths.ts";
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

  it("writes the final turns, tool calls and tokens to the manifest on close", () => {
    const registry = createRegistry({
      bus: createBus<BusEvents>(),
      handoffPath: (id) => `/tmp/${id}-handoff.md`,
    });
    const record = registry.create(newAgent(tempDir()));

    registry.update(record.id, { state: "running" });
    registry.update(record.id, { turns: 3, toolCalls: 4, tokens: 12_300 });
    registry.close(record.id, { state: "done" });

    const manifest = JSON.parse(readFileSync(join(record.dir, MANIFEST_FILE), "utf8"));

    expect(manifest).toMatchObject({ turns: 3, toolCalls: 4, tokens: 12_300, state: "done" });
  });
});
