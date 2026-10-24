import { describe, expect, it } from "vitest";
import type { ThemeLike } from "../../../core/adapter/contract.ts";
import { SPENDING_STATUS_KEY, type SpendingTotals } from "../../../core/manager/channels.ts";
import { plainTheme } from "../../../core/test/helpers/fakes.ts";
import { type FooterState, renderFooter } from "../src/render.ts";

const tokenTheme: ThemeLike = { ...plainTheme, fg: (token, text) => `<${token}>${text}` };

const boldTheme: ThemeLike = { ...tokenTheme, bold: (text) => `<b>${text}</b>` };

const model = { name: "test-model", contextWindow: 1_000_000, reasoning: true };

const totals: SpendingTotals = {
  main: { cost: 4, tokens: 150_000 },
  sources: [{ source: "agents", cost: 0.42, tokens: 12_400 }],
  subscription: false,
};

const state = (patch: Partial<FooterState> = {}): FooterState => ({
  context: { tokens: 150_100, window: 1_000_000, percent: 15 },
  model,
  thinking: "high",
  cycleKey: "shift+tab",
  cwd: "/work/my-project",
  sessionName: undefined,
  totals,
  cache: undefined,
  ...patch,
});

const render = (patch: Partial<FooterState> = {}, branch: string | null = null, statuses = new Map()) =>
  renderFooter(plainTheme, state(patch), { branch, statuses });

const paint = (patch: Partial<FooterState> = {}, branch: string | null = null, theme = tokenTheme) =>
  renderFooter(theme, state(patch), { branch, statuses: new Map() });

const statsOf = (patch: Partial<FooterState>) => render(patch)[1];

const costOf = (cost: number) => statsOf({ totals: { ...totals, main: { cost, tokens: 0 } } });

describe("renderFooter", () => {
  it("renders the padded block between a blank line above and below", () => {
    expect(render()).toEqual([
      "",
      " 150.1k · $4.00 · test-model (1M context)",
      " session total (agents included) 162.4k · $4.42",
      " my-project",
      " thinking high (shift+tab to cycle)",
      "",
    ]);
  });

  it("adds the branch, the session name and the statuses", () => {
    const lines = render({ sessionName: "refactor" }, "feature-branch", new Map([["other", "busy"]]));

    expect(lines).toEqual([
      "",
      " 150.1k · $4.00 · test-model (1M context)",
      " session total (agents included) 162.4k · $4.42",
      " my-project git:(feature-branch) • refactor",
      " thinking high (shift+tab to cycle)",
      "",
      " busy",
      "",
    ]);
  });

  it("hides the cost and the session total until spending publishes", () => {
    expect(render({ totals: undefined })).toEqual([
      "",
      " 150.1k · test-model (1M context)",
      " my-project",
      " thinking high (shift+tab to cycle)",
      "",
    ]);
  });

  it("formats the main cost", () => {
    expect(costOf(0.004)).toBe(" 150.1k · <$0.01 · test-model (1M context)");
  });

  it("formats the context window", () => {
    expect(statsOf({ model: { ...model, contextWindow: 200_000 }, totals: undefined })).toBe(
      " 150.1k · test-model (200k context)",
    );
  });

  it("colours the context tokens by occupancy", () => {
    const at = (percent: number) => paint({ context: { tokens: 1000, window: 2000, percent } })[1];

    expect([50, 70, 71, 90, 91].map((percent) => at(percent).split("<muted>")[0])).toEqual([
      " <success>1.0k",
      " <success>1.0k",
      " <warning>1.0k",
      " <warning>1.0k",
      " <error>1.0k",
    ]);
  });

  it("shows the session cache hit after the context tokens, coloured by rate", () => {
    expect(statsOf({ cache: 91.4 })).toBe(" 150.1k · cache 91% · $4.00 · test-model (1M context)");

    const painted = (cache: number) => paint({ cache })[1];

    expect(painted(91)).toContain("<muted>cache <success>91%");
    expect(painted(50)).toContain("<warning>50%");
    expect(painted(12)).toContain("<error>12%");
  });

  it("paints the thinking label bold in the colour of its level, without a mode mark", () => {
    const line = (thinking: string) => paint({ thinking }, null, boldTheme)[4];

    expect(line("high")).toBe(" <b><thinkingHigh>thinking high</b> <dim>(shift+tab to cycle)");
    expect(line("")).toContain("<b><thinkingOff>thinking off</b>");
    expect(line("xhigh")).toContain("<thinkingXhigh>thinking xhigh");
    expect(line("max")).toContain("<thinkingMax>thinking max");
    expect(line("max")).not.toContain("thinkingXhigh");
  });

  it("tints each kind of value its own way, with muted separators and dim labels", () => {
    const lines = paint({ sessionName: "refactor", cache: 91 }, "feature-branch");

    expect(lines[1]).toBe(
      " <success>150.1k<muted> · <muted>cache <success>91%<muted> · <text>$4.00<muted> · <borderAccent>test-model <muted>(1M context)",
    );
    expect(lines[2]).toBe(" <muted>session total (agents included) <text>162.4k<muted> · <text>$4.42");
    expect(lines[3]).toBe(
      " <border>my-project<muted> git:(<syntaxString>feature-branch<muted>)<muted> • refactor",
    );
  });

  it("tints the folder alone when there is no branch or session name", () => {
    expect(paint()[3]).toBe(" <border>my-project");
  });

  it("paints key hints dim and every other label or separator muted", () => {
    const tokensOf = (line: string) => Array.from(line.matchAll(/<(\w+)>/g), (match) => match[1]);
    const greys = (line: string) => tokensOf(line).filter((token) => token === "dim" || token === "muted");
    const lines = paint({ sessionName: "refactor", cache: 91 }, "feature-branch");
    const unavailable = paint({ model: { ...model, reasoning: false } })[4];

    expect([1, 2, 3].flatMap((index) => greys(lines[index])).every((token) => token === "muted")).toBe(true);
    expect(greys(lines[4])).toEqual(["dim"]);
    expect(unavailable).toBe(" <muted>thinking unavailable <dim>(shift+tab to cycle)");
  });

  it("tints the model name violet, leaves spend plain and nothing on the line bold", () => {
    const line = (patch: Partial<FooterState>) => paint(patch, null, boldTheme)[1];

    expect(line({})).not.toContain("<b>");
    expect(paint({}, null, boldTheme)[2]).not.toContain("<b>");
    expect(line({ model: undefined })).toMatch(/<muted>no model$/);
  });

  it("tints the branch cyan instead of orange when the theme paints orange like the success gauge", () => {
    const greenStrings: ThemeLike = {
      ...tokenTheme,
      fg: (token, text) => tokenTheme.fg(token === "syntaxString" ? "success" : token, text),
    };
    const line = (theme: ThemeLike) => paint({}, "main", theme)[3];

    expect(line(tokenTheme)).toContain("<syntaxString>main");
    expect(line(greenStrings)).toBe(line(tokenTheme).replace("<syntaxString>", "<syntaxVariable>"));
  });

  it("drops the cache segment first when the line is too narrow", () => {
    const at = (width: number) =>
      renderFooter(plainTheme, state({ cache: 91 }), { branch: null, statuses: new Map() }, width)[1];

    expect(at(53)).toBe(" 150.1k · cache 91% · $4.00 · test-model (1M context)");
    expect(at(52)).toBe(" 150.1k · $4.00 · test-model (1M context)");
  });

  it("marks unknown context and a missing model", () => {
    expect(statsOf({ context: { tokens: null, window: 0, percent: null }, model: undefined })).toBe(
      " ? · $4.00 · no model",
    );

    expect(paint({ context: { tokens: null, window: 0, percent: null } })[1]).toMatch(/^ <muted>\?<muted>/);
  });

  it("marks subscription sessions on the session total", () => {
    const sub = { ...totals, subscription: true };

    expect(render({ totals: sub })[2]).toBe(" session total (agents included) 162.4k · $4.42 (sub)");
    expect(paint({ totals: sub })[2]).toContain("<muted> (sub)");
  });

  it("names the last folder of the path", () => {
    expect(render({ cwd: "/work/my-project/" })[3]).toBe(" my-project");
    expect(render({ cwd: "C:\\work\\my-project", sessionName: "refactor" })[3]).toBe(
      " my-project • refactor",
    );
  });

  it("shows the thinking level, off when empty", () => {
    expect(render({ thinking: "" })[4]).toBe(" thinking off (shift+tab to cycle)");
  });

  it("lists one line per status by key, collapses whitespace and skips the spending status", () => {
    const statuses = new Map([
      ["zeta", "last"],
      [SPENDING_STATUS_KEY, "main $1.000 · total $1.000"],
      ["alpha", "  first\n  line "],
      ["empty", "   "],
    ]);

    expect(render({}, null, statuses).slice(-4)).toEqual(["", " first line", " last", ""]);
    expect(render({}, null, new Map([[SPENDING_STATUS_KEY, "main $1.000"]]))).toEqual(render());
  });
});
