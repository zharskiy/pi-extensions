import { describe, expect, it } from "vitest";
import type { PromptRecord, ThemeLike, TranscriptItem } from "../../../../core/adapter/contract.ts";
import { plainTheme } from "../../../../core/test/helpers/fakes.ts";
import {
  type BreakdownInput,
  contextBreakdown,
  limitLineText,
  limitTone,
  renderBreakdown,
} from "../../src/components/context-breakdown.ts";

const chars = (count: number) => "x".repeat(count);

const prompt: PromptRecord = {
  sections: [
    { name: "preamble", text: chars(400) },
    { name: "skills", text: chars(200) },
    { name: "cwd", text: chars(40) },
  ],
  tools: [{ name: "read", description: "Read", parameters: { type: "object" } }],
  skills: [{ name: "search", description: "Search" }],
  guidelines: [],
};

const items: TranscriptItem[] = [
  { kind: "user", text: chars(80) },
  {
    kind: "assistant",
    text: chars(40),
    thinking: chars(20),
    toolCalls: [{ name: "ls", args: { p: 1 } }],
    raw: {},
  },
  { kind: "tool", toolName: "ls", toolCallId: "c1", text: chars(400), isError: false, raw: {} },
  { kind: "custom", customType: "note", text: chars(40), raw: {} },
];

const input = (overrides: Partial<BreakdownInput> = {}): BreakdownInput => ({
  prompt,
  items,
  limit: 1_000,
  window: 4_000,
  softRatio: 0.8,
  estimate: (text) => Math.ceil(text.length / 4),
  ...overrides,
});

const tokensOf = (breakdown: ReturnType<typeof contextBreakdown>, label: string) =>
  breakdown.rows.find((row) => row.label === label)?.tokens;

describe("context breakdown", () => {
  it("splits the prompt into system prompt, tools and skills and sums the messages", () => {
    const breakdown = contextBreakdown(input());
    const toolsJson = JSON.stringify(prompt.tools).length;

    expect(tokensOf(breakdown, "system prompt")).toBe(110);
    expect(tokensOf(breakdown, "skills")).toBe(50);
    expect(tokensOf(breakdown, "tools")).toBe(Math.ceil(toolsJson / 4));
    expect(tokensOf(breakdown, "user")).toBe(30);
    expect(tokensOf(breakdown, "assistant")).toBe(
      Math.ceil((60 + `ls${JSON.stringify({ p: 1 })}`.length) / 4),
    );
    expect(tokensOf(breakdown, "tool results")).toBe(100);

    const shares = ["user", "assistant", "tool results"].map((label) => tokensOf(breakdown, label) ?? 0);
    const categories = ["system prompt", "tools", "skills", "messages"].map(
      (label) => tokensOf(breakdown, label) ?? 0,
    );
    const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

    expect(tokensOf(breakdown, "messages")).toBe(sum(shares));
    expect(breakdown.measured).toBe(false);
    expect(breakdown.used).toBe(sum(categories));
    expect(breakdown.free).toBe(1_000 - breakdown.used);
  });

  it("uses the measured total for used and free space without scaling the estimates", () => {
    const estimated = contextBreakdown(input());
    const breakdown = contextBreakdown(input({ measured: 700 }));

    expect(breakdown.measured).toBe(true);
    expect(breakdown.used).toBe(700);
    expect(breakdown.free).toBe(300);
    expect(tokensOf(breakdown, "system prompt")).toBe(tokensOf(estimated, "system prompt"));
    expect(breakdown.rows.find((row) => row.label === "used")?.estimated).toBe(false);
    expect(breakdown.rows.find((row) => row.label === "tools")?.estimated).toBe(true);
  });

  it("clamps free space at zero past the limit", () => {
    const breakdown = contextBreakdown(input({ measured: 1_500 }));

    expect(breakdown.free).toBe(0);
    expect(breakdown.rows.find((row) => row.label === "free space")?.tone).toBe("error");
  });

  it("colours success below the soft ratio, warning up to the limit and error at it", () => {
    expect(limitTone(799, 1_000, 0.8)).toBe("success");
    expect(limitTone(800, 1_000, 0.8)).toBe("warning");
    expect(limitTone(999, 1_000, 0.8)).toBe("warning");
    expect(limitTone(1_000, 1_000, 0.8)).toBe("error");
    expect(contextBreakdown(input({ measured: 850 })).rows.find((row) => row.label === "used")?.tone).toBe(
      "warning",
    );
  });

  it("states the limit against the model window", () => {
    expect(limitLineText(contextBreakdown(input()))).toBe("limit 1.0k tokens (25% of the model window 4.0k)");
    expect(limitLineText(contextBreakdown(input({ window: 0 })))).toBe(
      "limit 1.0k tokens (model window unknown)",
    );
  });

  it("marks estimated figures and colours percent and bar through the theme", () => {
    const tagged: ThemeLike = { fg: (token, text) => `<${token}>${text}</>`, bold: (text) => text };
    const lines = renderBreakdown(contextBreakdown(input({ measured: 900 })), tagged, 100, "x hides");

    expect(lines[0]).toContain("~ marks estimates");
    expect(lines[0]).toMatch(/ · x hides$/);
    expect(lines[1]).toMatch(
      /^ {2}system prompt +110~<success> +11\.0%<\/> {2}<success>██<\/><dim>░{18}<\/>$/,
    );
    expect(lines.find((line) => line.startsWith("  used"))).toMatch(/used +900 <warning> +90\.0%<\/>/);
    expect(lines.at(-1)).toBe("<warning>  limit 1.0k tokens (25% of the model window 4.0k)</>");
  });

  it("drops the bar on narrow widths", () => {
    const lines = renderBreakdown(contextBreakdown(input()), plainTheme, 34, "x hides");

    expect(lines[1]).toBe("  system prompt      110~  11.0%");
  });
});
