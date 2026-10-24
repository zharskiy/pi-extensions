import { describe, expect, it } from "vitest";
import { plainTheme } from "../../../test-framework/index.ts";
import { apportion } from "../src/breakdown.ts";
import { renderSnapshot } from "../src/render.ts";
import { breakdown, snapshot, usage } from "./support/context-snapshots.ts";

const render = (patch = {}) =>
  renderSnapshot(plainTheme, snapshot(patch), { width: 120, expanded: false, expandKey: "ctrl+o" });

const legend = (lines: string[]) =>
  lines
    .map((line) => /[■·░] ([^:]+): ([\d.]+k?)/.exec(line.slice(26)))
    .filter((match) => match !== null)
    .map((match) => `${match[1]} ${match[2]}`);

const grid = (lines: string[]) =>
  lines
    .slice(1, 11)
    .map((line) => line.slice(4, 23))
    .join(" ");

const cacheLine = (lines: string[]) =>
  lines.find((line) => line.includes("Cache hit:"))?.replace(/^.*Cache/, "Cache");

describe("usage model", () => {
  it("gives messages the rest of the measured total and the free space what is left after the reserve", () => {
    expect(legend(render())).toEqual([
      "System prompt 4.1k",
      "System tools 5.3k",
      "MCP tools 1.8k",
      "Extension tools 2.6k",
      "Memory files 3.2k",
      "Skills 1.4k",
      "Messages 42.8k",
      "Free space 122.4k",
      "Compaction reserve 16.4k",
    ]);
  });

  it("sums the estimates and the message buckets when pi does not know the total", () => {
    const lines = render({ breakdown: breakdown({ total: null }) });

    expect(lines[1]).toContain("Test Model · ~61.2k/200k tokens (31%) · estimated");
    expect(legend(lines)).toContain("Messages 42.8k");
  });

  it("scales the estimates down to the measured total when they exceed it, leaving no messages row", () => {
    const lines = render({ breakdown: breakdown({ total: 920 }) });
    const rows = legend(lines).filter((row) => !row.startsWith("Free") && !row.startsWith("Compaction"));

    expect(lines[1]).toContain("920/200k tokens (0%)");
    expect(rows).toEqual([
      "System prompt 205",
      "System tools 265",
      "MCP tools 90",
      "Extension tools 130",
      "Memory files 160",
      "Skills 70",
    ]);
    expect(rows.reduce((sum, row) => sum + Number(row.split(" ").at(-1)), 0)).toBe(920);
  });

  it("shows a zero free row once the window is full and the overflow past it", () => {
    const full = render({ breakdown: breakdown({ total: 190_000 }) });
    const over = render({ breakdown: breakdown({ total: 205_000 }) });

    expect(full).toContain("                          · Free space: 0 (0%)");
    expect(full.some((line) => line.includes("exceeds"))).toBe(false);
    expect(over).toContain("    Context exceeds the window by 5.0k tokens · /compact");
  });
});

describe("grid", () => {
  it("fills categories row-major in legend order, then free, then the reserve at the end", () => {
    expect(grid(render())).toBe(
      [
        "■ ■ ■ ■ ■ ■ ■ ■ ■ ■",
        "■ ■ ■ ■ ■ ■ ■ ■ ■ ■",
        "■ ■ ■ ■ ■ ■ ■ ■ ■ ■",
        "■ · · · · · · · · ·",
        "· · · · · · · · · ·",
        "· · · · · · · · · ·",
        "· · · · · · · · · ·",
        "· · · · · · · · · ·",
        "· · · · · · · · · ·",
        "· · ░ ░ ░ ░ ░ ░ ░ ░",
      ].join(" "),
    );
  });

  it("never lets used cells eat the reserve", () => {
    const cells = grid(render({ breakdown: breakdown({ total: 400_000 }) }));

    expect(cells.match(/░/g)).toHaveLength(8);
    expect(cells).not.toContain("·");
  });

  it("is all free without a known window", () => {
    expect(grid(render({ breakdown: breakdown({ window: 0 }) }))).not.toMatch(/[■░]/);
  });
});

describe("cache line", () => {
  it("rounds the last request and the session hit rates", () => {
    expect(
      cacheLine(
        render({
          lastRequest: usage({ input: 13, cacheRead: 87 }),
          session: usage({ input: 9, cacheRead: 91 }),
        }),
      ),
    ).toBe("Cache hit: last turn 87% · session 91%");
  });

  it("is hidden until the session reported cache reads or writes", () => {
    expect(
      cacheLine(render({ lastRequest: usage({ input: 100 }), session: usage({ input: 100 }) })),
    ).toBeUndefined();
    expect(
      cacheLine(render({ lastRequest: undefined, session: usage({ input: 100, cacheWrite: 100 }) })),
    ).toBe("Cache hit: session 0%");
  });

  it("shows a last request without cache activity in a session that had it as 0%", () => {
    expect(
      cacheLine(render({ lastRequest: usage({ input: 100 }), session: usage({ input: 50, cacheRead: 50 }) })),
    ).toBe("Cache hit: last turn 0% · session 50%");
  });
});

describe("apportion", () => {
  it("splits a total by largest remainder, ties to the earlier weight", () => {
    expect(apportion([1, 1, 1], 10)).toEqual([4, 3, 3]);
    expect(apportion([2.5, 2.5], 3)).toEqual([2, 1]);
    expect(apportion([4_100, 5_300], 0)).toEqual([0, 0]);
    expect(apportion([0, 0], 5)).toEqual([0, 0]);
  });
});
