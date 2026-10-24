import { describe, expect, it } from "vitest";
import { plainTheme } from "../../../../../core/test/helpers/fakes.ts";
import { requestLineCount, requestLines } from "../../../src/plugins/agent-view/request-block.ts";
import { recordingTheme } from "../../helpers/overlay.ts";

const payload = () => ({
  model: "provider/model",
  system: "You are explorer.",
  tools: [{ name: "read", parameters: { type: "object", properties: { path: { type: "string" } } } }],
});

const pretty = (value: unknown) => JSON.stringify(value, null, 2).split("\n");

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
    expect(requestLines(twelve, true, false, 80, plainTheme)).toEqual([" Request · 12 lines (r to expand)"]);
    expect(requestLines(twelve, true, false, 80, recordingTheme)).toEqual([
      " <muted>Request · 12 lines</> <dim>(r to expand)</>",
    ]);
  });

  it("says not sent yet when open and not recorded when closed", () => {
    expect(requestLines(undefined, true, false, 80, plainTheme)).toEqual([" Request · not sent yet"]);
    expect(requestLines(undefined, false, false, 80, plainTheme)).toEqual([" Request · not recorded"]);
    expect(requestLines(undefined, true, true, 80, plainTheme)).toEqual([" Request · not sent yet"]);
    expect(requestLines(undefined, false, true, 80, plainTheme)).toEqual([" Request · not recorded"]);
  });

  it("expands to the pretty-printed request at PAD + 2", () => {
    const value = payload();
    const lines = requestLines(value, false, true, 120, plainTheme);

    expect(lines[0]).toBe(` Request · ${pretty(value).length} lines (r to collapse)`);
    expect(lines.slice(1)).toEqual(pretty(value).map((line) => `   ${line}`));
  });

  it("wraps long string values at the inner width minus 2", () => {
    const value = { system: "s".repeat(300) };
    const lines = requestLines(value, false, true, 40, plainTheme).slice(1);
    const long = pretty(value)[1] as string;

    expect(lines.every((line) => line.startsWith("   ") && plainTheme.width(line) <= 39)).toBe(true);
    expect(
      lines
        .slice(1, -1)
        .map((line) => line.slice(3))
        .join(""),
    ).toBe(long);
  });
});
