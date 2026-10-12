import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createBus } from "../../../../../core/manager/bus.ts";
import type { BusEvents } from "../../../src/model/events.ts";
import { MAIN_CALLER } from "../../../src/model/types.ts";
import { createRegistry } from "../../../src/plugins/agent-registry/registry.ts";
import { tempDir } from "../../helpers/harness.ts";

const newAgent = (dir: string) => ({
  agent: "explorer",
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
    const ids = ["explorer-aaaa", "explorer-aaaa", "explorer-bbbb"];

    mkdirSync(join(dir, "explorer-aaaa"));

    const registry = createRegistry({ bus: createBus<BusEvents>(), newId: () => ids.shift() ?? "" });

    expect(registry.create(newAgent(dir)).id).toBe("explorer-bbbb");
  });
});
