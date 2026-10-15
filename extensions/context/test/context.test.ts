import { describe, expect, it } from "vitest";
import type { SessionInfo } from "../../../core/adapter/contract.ts";
import { createFakeHost } from "../../../core/test/helpers/fakes.ts";
import { createContext, SNAPSHOT_ENTRY } from "../src/context.ts";
import { breakdown, STAMP, usage } from "./fixtures.ts";

const setup = (info: Partial<SessionInfo> = {}) => {
  const host = createFakeHost({ cwd: "/home/me/work", ...info });

  createContext(host, { home: "/home/me", now: () => STAMP });
  host.breakdown = breakdown({
    memoryFiles: [
      { name: "/home/me/work/AGENTS.md", tokens: 2_100 },
      { name: "/home/me/.pi/agent/AGENTS.md", tokens: 1_100 },
    ],
  });
  host.lastUsage = usage(130, 870);
  host.mainUsage = usage(90, 910);
  host.start();

  return host;
};

describe("/context", () => {
  it("appends a frozen snapshot entry with short paths that the registered renderer draws", async () => {
    const host = setup();

    await host.runCommand("context");

    expect(host.entries).toHaveLength(1);
    expect(host.entries[0].customType).toBe(SNAPSHOT_ENTRY);
    expect(host.entries[0].data).toMatchObject({
      lastRequest: usage(130, 870),
      session: usage(90, 910),
      timestamp: STAMP,
      expandedByDefault: false,
      breakdown: {
        memoryFiles: [
          { name: "./AGENTS.md", tokens: 2_100 },
          { name: "~/.pi/agent/AGENTS.md", tokens: 1_100 },
        ],
      },
    });

    host.mainUsage = usage(1, 0);

    const lines = host.renderEntry(SNAPSHOT_ENTRY, host.entries[0].data);

    expect(lines[0]).toBe(" Context Usage · 14:32");
    expect(lines[2]).toContain("Cache hit: 87% last turn · 91% session");
    expect(lines.at(-1)).toBe(" <app.tools.expand> to expand");
    expect(host.renderEntry(SNAPSHOT_ENTRY, host.entries[0].data, { expanded: true })).toContain(
      " └ ./AGENTS.md: 2.1k tokens",
    );
  });

  it("stores all as expanded by default and completes it", async () => {
    const host = setup();
    const spec = host.commands.get("context");

    await host.runCommand("context", " all ");

    expect(host.entries[0].data).toMatchObject({ expandedByDefault: true });
    expect(spec?.complete?.("a")).toEqual([{ value: "all", label: "all" }]);
    expect(spec?.complete?.("x")).toBeNull();
  });

  it("notifies a one-line summary instead of an entry outside tui mode", async () => {
    const host = setup({ mode: "rpc" });

    await host.runCommand("context");

    expect(host.entries).toEqual([]);
    expect(host.notices).toEqual([
      {
        message: "Context: Test Model · 61.2k/200k tokens (31%) · Cache hit: 87% last turn · 91% session",
        level: undefined,
      },
    ]);
  });

  it("warns when there is nothing to measure", async () => {
    const host = setup();

    host.breakdown = undefined;
    await host.runCommand("context");

    expect(host.entries).toEqual([]);
    expect(host.notices).toEqual([{ message: "No live session to measure.", level: "warning" }]);
  });

  it("draws nothing for entries it cannot read", () => {
    expect(setup().renderEntry(SNAPSHOT_ENTRY, { foreign: true })).toEqual([]);
  });
});
