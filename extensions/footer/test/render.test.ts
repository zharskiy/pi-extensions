import { describe, expect, it } from "vitest";
import type { ThemeLike } from "../../../core/adapter/contract.ts";
import { SPENDING_STATUS_KEY, type SpendingTotals } from "../../../core/manager/channels.ts";
import { plainTheme } from "../../../core/test/helpers/fakes.ts";
import { type FooterState, renderFooter } from "../src/render.ts";

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

const plain = (text: string) => text.replace(ANSI, "");

const tokenTheme: ThemeLike = { ...plainTheme, fg: (token, text) => `<${token}>${text}` };

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
  renderFooter(plainTheme, state(patch), { branch, statuses }).map(plain);

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
    expect([0, -1, 0.004, 0.01, 4.425].map(costOf)).toEqual([
      " 150.1k · $0.00 · test-model (1M context)",
      " 150.1k · $0.00 · test-model (1M context)",
      " 150.1k · <$0.01 · test-model (1M context)",
      " 150.1k · $0.01 · test-model (1M context)",
      " 150.1k · $4.42 · test-model (1M context)",
    ]);
  });

  it("formats the context window", () => {
    const windows = [512, 200_000, 128_500, 1_000_000, 1_500_000].map((contextWindow) =>
      statsOf({ model: { ...model, contextWindow }, totals: undefined }),
    );

    expect(windows).toEqual([
      " 150.1k · test-model (512 context)",
      " 150.1k · test-model (200k context)",
      " 150.1k · test-model (129k context)",
      " 150.1k · test-model (1M context)",
      " 150.1k · test-model (1.5M context)",
    ]);
  });

  it("colours the context tokens by occupancy", () => {
    const at = (percent: number) =>
      renderFooter(tokenTheme, state({ context: { tokens: 1000, window: 2000, percent } }), {
        branch: null,
        statuses: new Map(),
      })[1];

    expect(at(95)).toContain("<error>1.0k");
    expect(at(80)).toContain("<warning>1.0k");
    expect(at(50)).not.toMatch(/<(error|warning)>/);
  });

  it("shows the session cache hit after the context tokens, coloured by rate", () => {
    expect(statsOf({ cache: 91.4 })).toBe(" 150.1k · cache 91% · $4.00 · test-model (1M context)");

    const painted = (cache: number) =>
      renderFooter(tokenTheme, state({ cache }), { branch: null, statuses: new Map() })[1];

    expect(painted(91)).toContain("<dim>cache <success>91%");
    expect(painted(50)).toContain("<warning>50%");
    expect(painted(12)).toContain("<error>12%");
  });

  it("renders the session total label dim before its values", () => {
    const line = renderFooter(tokenTheme, state({}), { branch: null, statuses: new Map() })[2];

    expect(plain(line)).toBe(" <dim>session total (agents included) <text>162.4k<muted> · <text>$4.42");
  });

  it("paints the thinking label bold in the colour of its level, without a mode mark", () => {
    const boldTheme: ThemeLike = { ...tokenTheme, bold: (text) => `<b>${text}</b>` };
    const line = (thinking: string) =>
      renderFooter(boldTheme, state({ thinking }), { branch: null, statuses: new Map() })[4];

    expect(line("high")).toBe(" <b><thinkingHigh>thinking high</b> <dim>(shift+tab to cycle)");
    expect(line("")).toContain("<b><thinkingOff>thinking off</b>");
    expect(line("xhigh")).toContain("<thinkingXhigh>thinking xhigh");
    expect(line("max")).toContain("<thinkingXhigh>thinking max");
  });

  it("paints every segment through theme tokens, with muted separators", () => {
    const lines = renderFooter(tokenTheme, state({ sessionName: "refactor" }), {
      branch: "feature-branch",
      statuses: new Map(),
    });

    expect(lines[1]).toBe(
      " <text>150.1k<muted> · <text>$4.00<muted> · <accent>test-model <muted>(1M context)",
    );
    expect(lines[3]).toBe(" <accent>my-project<muted> git:(<text>feature-branch<muted>)<dim> • refactor");
    expect(lines.join("")).not.toContain(`${String.fromCharCode(27)}[38;5;`);
  });

  it("drops the cache segment first when the line is too narrow", () => {
    const at = (width: number) =>
      plain(renderFooter(plainTheme, state({ cache: 91 }), { branch: null, statuses: new Map() }, width)[1]);

    expect(at(53)).toBe(" 150.1k · cache 91% · $4.00 · test-model (1M context)");
    expect(at(52)).toBe(" 150.1k · $4.00 · test-model (1M context)");
  });

  it("marks unknown context and a missing model", () => {
    expect(statsOf({ context: { tokens: null, window: 0, percent: null }, model: undefined })).toBe(
      " ? · $4.00 · no model",
    );
  });

  it("marks subscription sessions on the session total", () => {
    const sub = { ...totals, subscription: true };

    expect(render({ totals: sub })[2]).toBe(" session total (agents included) 162.4k · $4.42 (sub)");
    expect(
      renderFooter(tokenTheme, state({ totals: sub }), { branch: null, statuses: new Map() })[2],
    ).toContain("<dim> (sub)");
  });

  it("names the last folder of the path", () => {
    expect(render({ cwd: "/work/my-project/" })[3]).toBe(" my-project");
    expect(render({ cwd: "C:\\work\\my-project", sessionName: "refactor" })[3]).toBe(
      " my-project • refactor",
    );
  });

  it("shows the thinking level, off when empty and unavailable without reasoning", () => {
    expect(render({ thinking: "" })[4]).toBe(" thinking off (shift+tab to cycle)");
    expect(render({ model: { ...model, reasoning: false } })[4]).toBe(
      " thinking unavailable (shift+tab to cycle)",
    );
  });

  it("lists one line per status by key, collapses whitespace and skips the spending status", () => {
    const statuses = new Map([
      ["zeta", "last"],
      [SPENDING_STATUS_KEY, "main $1.000 · total $1.000"],
      ["alpha", "  first\n  line "],
      ["empty", "   "],
    ]);

    expect(render({}, null, statuses).slice(-4)).toEqual(["", " first line", " last", ""]);
    expect(render().some((line) => line.includes("← to list agents"))).toBe(false);
    expect(render({}, null, new Map([[SPENDING_STATUS_KEY, "main $1.000"]]))).toEqual(render());
  });
});
