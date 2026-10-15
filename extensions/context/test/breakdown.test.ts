import { describe, expect, it } from "vitest";
import {
  cacheFigures,
  gridCells,
  parseSnapshot,
  shortPath,
  type UsageModel,
  usageModel,
} from "../src/breakdown.ts";
import { breakdown, snapshot, usage } from "./fixtures.ts";

const totals = (model: UsageModel) =>
  Object.fromEntries(model.categories.map((category) => [category.key, category.tokens]));

describe("usageModel", () => {
  it("gives messages the rest of the measured total and the free space what is left after the reserve", () => {
    const model = usageModel(snapshot());

    expect(totals(model)).toEqual({
      systemPrompt: 4_100,
      systemTools: 5_300,
      mcpTools: 1_800,
      extensionTools: 2_600,
      memoryFiles: 3_200,
      skills: 1_400,
      messages: 42_800,
      free: 122_416,
      reserve: 16_384,
    });
    expect(model.used).toBe(61_200);
    expect(model.estimated).toBe(false);
    expect(Math.round(model.percent)).toBe(31);
  });

  it("falls back to the chars/4 sum when pi does not know the total", () => {
    const model = usageModel(snapshot({ breakdown: breakdown({ total: null }) }));

    expect(model.estimated).toBe(true);
    expect(model.used).toBe(18_400 + 42_800);
  });

  it("scales the estimates down to the measured total when they exceed it, leaving messages at zero", () => {
    const model = usageModel(snapshot({ breakdown: breakdown({ total: 9_200 }) }));
    const used = model.categories.filter((category) => !["free", "reserve"].includes(category.key));

    expect(model.categories.some((category) => category.key === "messages")).toBe(false);
    expect(used.reduce((sum, category) => sum + category.tokens, 0)).toBe(9_200);
    expect(totals(model)).toMatchObject({ systemPrompt: 2_050, systemTools: 2_650, skills: 700 });
  });

  it("keeps a zero free row and the overflow once the window is full", () => {
    const model = usageModel(snapshot({ breakdown: breakdown({ total: 190_000 }) }));

    expect(model.full).toBe(true);
    expect(model.overflow).toBe(0);
    expect(totals(model).free).toBe(0);
    expect(usageModel(snapshot({ breakdown: breakdown({ total: 205_000 }) })).overflow).toBe(5_000);
  });
});

describe("gridCells", () => {
  it("fills categories row-major in legend order, then free, then the reserve at the end", () => {
    const cells = gridCells(usageModel(snapshot()), 100);

    expect(cells).toHaveLength(100);
    expect(cells.slice(0, 10).map((cell) => `${cell.key}${cell.partial ? "~" : ""}`)).toEqual([
      "systemPrompt",
      "systemPrompt",
      "systemTools",
      "systemTools",
      "systemTools~",
      "mcpTools~",
      "extensionTools",
      "memoryFiles",
      "skills~",
      "messages",
    ]);
    expect(cells.filter((cell) => cell.key === "reserve")).toHaveLength(8);
    expect(cells.at(-1)?.key).toBe("reserve");
    expect(cells.findIndex((cell) => cell.key === "free")).toBe(31);
  });

  it("fills as many cells as the rounded percentage of the window", () => {
    const cells = gridCells(usageModel(snapshot()), 100);
    const used = cells.filter((cell) => cell.key !== "free" && cell.key !== "reserve");

    expect(used).toHaveLength(31);
    expect(used.at(-1)).toEqual({ key: "messages", partial: true });
    expect(used.filter((cell) => cell.partial)).toHaveLength(4);
  });

  it("never lets used cells eat the reserve", () => {
    const cells = gridCells(usageModel(snapshot({ breakdown: breakdown({ total: 400_000 }) })), 100);

    expect(cells.filter((cell) => cell.key === "reserve")).toHaveLength(8);
    expect(cells.some((cell) => cell.key === "free")).toBe(false);
  });

  it("is all free without a known window", () => {
    expect(gridCells(usageModel(snapshot({ breakdown: breakdown({ window: 0 }) })), 4)).toEqual(
      Array.from({ length: 4 }, () => ({ key: "free", partial: false })),
    );
  });
});

describe("cacheFigures", () => {
  it("rounds nothing and reports the last request and the session", () => {
    expect(cacheFigures(usage(13, 87), usage(9, 91))).toEqual({
      lastTurn: 87,
      lastMissed: false,
      session: 91,
    });
  });

  it("is undefined until the session reported cache reads or writes", () => {
    expect(cacheFigures(usage(100, 0), usage(100, 0))).toBeUndefined();
    expect(cacheFigures(undefined, usage(100, 0, 100))).toEqual({
      lastTurn: undefined,
      lastMissed: false,
      session: 0,
    });
  });

  it("flags a last request without cache activity in a session that had it", () => {
    expect(cacheFigures(usage(100, 0), usage(50, 50))).toEqual({
      lastTurn: 0,
      lastMissed: true,
      session: 50,
    });
  });
});

describe("helpers", () => {
  it("shortens paths under the working directory to ./ and under home to ~", () => {
    expect(shortPath("/home/me/work/AGENTS.md", "/home/me", "/home/me/work")).toBe("./AGENTS.md");
    expect(shortPath("/home/me/.pi/agent/AGENTS.md", "/home/me", "/home/me/work")).toBe(
      "~/.pi/agent/AGENTS.md",
    );
    expect(shortPath("/etc/AGENTS.md", "/home/me", "/home/me/work")).toBe("/etc/AGENTS.md");
  });

  it("parses stored snapshots and rejects foreign data", () => {
    expect(parseSnapshot(structuredClone(snapshot()))).toEqual(snapshot());
    expect(parseSnapshot({ ...snapshot(), lastRequest: null })?.lastRequest).toBeUndefined();
    expect(parseSnapshot({ breakdown: {} })).toBeUndefined();
    expect(parseSnapshot("text")).toBeUndefined();
    expect(parseSnapshot(undefined)).toBeUndefined();
  });
});
