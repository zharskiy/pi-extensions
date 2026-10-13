import { stripVTControlCharacters } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { plainTheme } from "../../../../core/test/helpers/fakes.ts";
import { displayWidth } from "../../src/components/format.ts";
import { requestLineCount, requestLines } from "../../src/components/request-block.ts";
import { recordingTheme } from "../helpers/overlay.ts";

const payload = () => ({
  model: "provider/model",
  system: "You are explorer.",
  tools: [{ name: "read", parameters: { type: "object", properties: { path: { type: "string" } } } }],
});

const pretty = (value: unknown) => JSON.stringify(value, null, 2).split("\n");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("request block", () => {
  it("counts the lines of the pretty-printed request", () => {
    const cyclic: Record<string, unknown> = {};

    cyclic.self = cyclic;

    expect(requestLineCount(payload())).toBe(pretty(payload()).length);
    expect(requestLineCount(undefined)).toBe(0);
    expect(requestLineCount(cyclic)).toBe(0);
  });

  it("draws one collapsed line with the count", () => {
    const twelve = { a: 1, b: 2, c: { d: 3, e: [1, 2] }, f: "x" };

    expect(pretty(twelve)).toHaveLength(12);
    expect(requestLines(twelve, true, false, 80, plainTheme)).toEqual([" ▸ Request · 12 lines"]);
    expect(requestLines(twelve, true, false, 80, recordingTheme)).toEqual([" <dim>▸ Request · 12 lines</>"]);
  });

  it("says not sent yet when open and not recorded when closed", () => {
    expect(requestLines(undefined, true, false, 80, plainTheme)).toEqual([" ▸ Request · not sent yet"]);
    expect(requestLines(undefined, false, false, 80, plainTheme)).toEqual([" ▸ Request · not recorded"]);
    expect(requestLines(undefined, true, true, 80, plainTheme)).toEqual([" ▸ Request · not sent yet"]);
    expect(requestLines(undefined, false, true, 80, plainTheme)).toEqual([" ▸ Request · not recorded"]);
  });

  it("expands to the pretty-printed request at PAD + 2", () => {
    const value = payload();
    const lines = requestLines(value, false, true, 120, plainTheme);

    expect(lines[0]).toBe(` ▾ Request · ${pretty(value).length} lines`);
    expect(lines.slice(1, -1)).toEqual(pretty(value).map((line) => `   ${line}`));
    expect(lines.at(-1)).toBe("");
  });

  it("wraps long string values at the inner width minus 2", () => {
    const value = { system: "s".repeat(300) };
    const lines = requestLines(value, false, true, 40, plainTheme).slice(1, -1);
    const long = pretty(value)[1] as string;

    expect(lines.every((line) => displayWidth(line) <= 39)).toBe(true);
    expect(lines.every((line) => line.startsWith("   "))).toBe(true);
    expect(
      lines
        .slice(1, -1)
        .map((line) => line.slice(3))
        .join(""),
    ).toBe(long);
  });

  it("does not split wide characters", () => {
    const lines = requestLines({ text: "漢字".repeat(60) }, false, true, 41, plainTheme);

    expect(lines.every((line) => displayWidth(stripVTControlCharacters(line)) <= 40)).toBe(true);
  });

  it("reuses the stringified request for the same payload", () => {
    const stringify = vi.spyOn(JSON, "stringify");
    const value = payload();

    requestLines(value, false, true, 80, plainTheme);
    requestLines(value, false, true, 60, plainTheme);

    expect(stringify).toHaveBeenCalledTimes(1);

    requestLines(payload(), false, true, 60, plainTheme);

    expect(stringify).toHaveBeenCalledTimes(2);
  });
});
