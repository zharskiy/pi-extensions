import { describe, expect, it } from "vitest";
import type { ThemeLike } from "../../../platform/pi-adapter/index.ts";
import { AGENTS_HINT_KEY, SPENDING_STATUS_KEY, type SpendingTotals } from "../../../platform/shared/index.ts";
import { paintRecordingTheme, plainTheme } from "../../../test/framework/index.ts";
import type { FooterState } from "../core/segments.ts";
import { renderFooter } from "../ui/render.ts";

const model = { name: "test-model", contextWindow: 1_000_000, reasoning: true };

const plainTotals: SpendingTotals = {
  main: { cost: 4.42, tokens: 162_400 },
  sources: [],
  subscription: false,
};

const withAgents: SpendingTotals = {
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
  totals: plainTotals,
  cache: undefined,
  limits: undefined,
  ...patch,
});

type Options = { branch?: string | null; statuses?: Map<string, string>; width?: number; theme?: ThemeLike };

const render = (patch: Partial<FooterState> = {}, options: Options = {}) =>
  renderFooter(
    options.theme ?? plainTheme,
    state(patch),
    { branch: options.branch ?? null, statuses: options.statuses ?? new Map() },
    options.width ?? 200,
  );

const paint = (patch: Partial<FooterState> = {}, options: Options = {}) => {
  const recording = paintRecordingTheme();

  renderFooter(
    recording.theme,
    state(patch),
    { branch: options.branch ?? null, statuses: options.statuses ?? new Map() },
    options.width ?? 200,
  );

  return recording;
};

const full = { sessionName: "refactor", cache: 73, totals: withAgents };

const tokensOf = (painted: { token: string }[]) => new Set(painted.map(({ token }) => token));

const at = (percent: number): Partial<FooterState> => ({
  context: { tokens: percent * 10, window: 1000, percent },
});

const present = (lines: string[], markers: string[]) =>
  markers.filter((marker) => lines.join("\n").includes(marker));

const widths = Array.from({ length: 91 }, (_, index) => 120 - index);

const lineAt = (index: number, patch: Partial<FooterState>, width: number, options: Options = {}) =>
  render(patch, { ...options, width })[index];

describe("renderFooter colours", () => {
  it("uses only text, muted and dim plus the thinking accent", () => {
    const { painted } = paint(full, { branch: "main" });
    const thinking = painted.filter(({ token }) => token.startsWith("thinking"));

    expect([...tokensOf(painted)].filter((token) => !token.startsWith("thinking")).sort()).toEqual([
      "dim",
      "muted",
      "text",
    ]);
    expect(thinking).toHaveLength(1);
  });

  it("paints the level word in the token of its level and nothing else with an accent", () => {
    const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

    levels.forEach((level) => {
      const { painted } = paint({ thinking: level });
      const accent = painted.filter(({ token }) => token.startsWith("thinking"));

      expect(accent).toEqual([{ token: `thinking${level[0].toUpperCase()}${level.slice(1)}`, text: level }]);
    });

    const unavailable = paint({ model: { ...model, reasoning: false } }).painted;
    const lines = render({ model: { ...model, reasoning: false } });

    expect(unavailable.some(({ token }) => token.startsWith("thinking"))).toBe(false);
    expect(lines.join("\n")).not.toContain("shift+tab");
    expect(lines.join("\n")).not.toContain("thinking");
  });

  it("never paints a figure dim and keeps the percent and the total plain text", () => {
    const { painted } = paint(full);

    const figures = ["15%", "73%", "162.4k", "$4.00", "$0.42", "$4.42"];

    figures.forEach((figure) => {
      expect(painted.filter(({ token, text }) => token === "dim" && text.includes(figure))).toEqual([]);
    });
    expect(painted).toContainEqual({ token: "text", text: "15%" });
    expect(painted).toContainEqual({ token: "text", text: "$4.42" });
  });

  it("colours the context by the window thresholds and nothing else", () => {
    const base = paint(at(69));
    const warn = paint(at(70));
    const error = paint(at(90));

    expect(base.painted).toContainEqual({ token: "text", text: "69%" });
    expect(base.painted).toContainEqual({ token: "dim", text: "of 1k" });
    expect(warn.painted).toContainEqual({ token: "warning", text: "70%" });
    expect(warn.painted).toContainEqual({ token: "warning", text: "of 1k" });
    expect(warn.bolded).toEqual([]);
    expect(error.painted).toContainEqual({ token: "error", text: "90%" });
    expect(error.painted).toContainEqual({ token: "error", text: "of 1k" });
    expect(error.painted).toContainEqual({ token: "error", text: "900" });
    expect(warn.painted).toContainEqual({ token: "warning", text: "700" });
    expect(base.painted).toContainEqual({ token: "text", text: "690" });
    expect(error.bolded).toEqual(expect.arrayContaining(["90%", "900"]));

    const rest = (spans: { token: string; text: string }[]) =>
      spans.filter(({ text }) => !/^\d+%?$|^of /.test(text));

    expect(rest(warn.painted)).toEqual(rest(base.painted));
    expect(rest(error.painted)).toEqual(rest(base.painted));
  });

  it("keeps the cache muted at every rate", () => {
    [5, 50, 95].forEach((cache) => {
      const { painted } = paint({ cache });

      expect(painted).toContainEqual({ token: "muted", text: `${cache}%` });
    });
  });

  it("never colours the cost", () => {
    const tokens = tokensOf(paint({ totals: withAgents, ...at(95) }).painted);

    expect(tokens.has("success")).toBe(false);
    expect(
      paint(at(95))
        .painted.filter(({ token }) => token === "error")
        .map(({ text }) => text),
    ).toEqual(expect.arrayContaining(["950", "95%", "of 1k"]));
    expect(
      paint(at(95))
        .painted.filter(({ token }) => token === "error")
        .map(({ text }) => text),
    ).not.toContain("$4.42");
  });

  it("shows the exact token count before the percent and drops it before the percent", () => {
    const at = (width: number) =>
      render({ context: { tokens: 42_318, window: 100_000, percent: 42 } }, { width })[2];

    expect(at(200)).toContain("context 42,318 · 42% of 100k");
    expect(at(32)).not.toContain("42,318");
    expect(at(32)).toContain("context 42%");
    expect(at(30)).toContain("context 42%");
    expect(at(30)).not.toContain("42,318");
  });

  it("marks unknown context and a missing model", () => {
    const lines = render({ context: { tokens: null, window: 0, percent: null }, model: undefined });

    expect(lines[1]).toContain("no model");
    expect(lines[2]).toContain("context ?");
    expect(lines[2]).not.toContain("of ");
  });
});

describe("renderFooter text", () => {
  it("draws the idle block over three lines", () => {
    const lines = render(
      { sessionName: "refactor", cache: 73, context: { tokens: 13_040, window: 163_000, percent: 8 } },
      { branch: "main", width: 80 },
    );

    expect(lines).toEqual([
      "",
      " my-project on main · refactor                        test-model · thinking high",
      " context 13,040 · 8% of 163k · cache 73%                   162.4k tokens · $4.42",
      " shift+tab to cycle thinking",
      "",
    ]);
  });

  it("uses a dot as the only separator", () => {
    const lines = render({ ...full, totals: { ...withAgents, subscription: true } }, { branch: "main" });

    lines.forEach((line) => {
      expect(line).not.toMatch(/[()•]|git:/);
    });
  });

  it("splits the cost only when agents spent something", () => {
    const alone = render({ totals: plainTotals })[2];
    const split = render({ totals: withAgents })[2];

    expect(alone.match(/\$/g)).toHaveLength(1);
    expect(alone).not.toContain("total");
    expect(split).toMatch(/\$4\.00 main · \$0\.42 agents · \$4\.42 total/);

    const { painted } = paint({ totals: withAgents });

    expect(painted.filter(({ token, text }) => token === "text" && text.startsWith("$"))).toEqual([
      { token: "text", text: "$4.42" },
    ]);
  });

  it("marks a subscription and shortens it before dropping anything else on the line", () => {
    const totals = { ...plainTotals, subscription: true };
    const { painted } = paint({ totals });
    const line = (width: number) => lineAt(2, { totals, cache: 73 }, width);
    const shortened = widths.filter(
      (width) => line(width).includes("on sub") && !line(width).includes("subscription"),
    );

    expect(painted.some(({ token, text }) => token === "text" && text.startsWith("$"))).toBe(false);
    expect(line(200)).toContain("on subscription");
    expect(shortened.length).toBeGreaterThan(0);
    expect(shortened.some((width) => line(width).includes("cache"))).toBe(true);
  });

  it("hides the money until spending publishes", () => {
    const line = render({ totals: undefined })[2];

    expect(line).not.toContain("$");
    expect(line).not.toContain("tokens");
  });

  it("names the last folder of the path", () => {
    expect(render({ cwd: "/work/my-project/" })[1]).toContain(" my-project ");
    expect(render({ cwd: "C:\\work\\my-project", sessionName: "refactor" })[1]).toContain(
      "my-project · refactor",
    );
  });

  it("shows the thinking level, off when empty", () => {
    expect(render({ thinking: "" })[1]).toContain("thinking off");
  });
});

describe("renderFooter layout", () => {
  it("ends the two top lines at the last column", () => {
    const patch = { ...full, sessionName: "refactor" };

    widths
      .filter((width) => width >= 60)
      .forEach((width) => {
        const lines = render(patch, { branch: "main", width });

        expect(plainTheme.width(lines[1])).toBe(width);
        expect(plainTheme.width(lines[2])).toBe(width);
      });
  });

  it("keeps the left side still when the figure grows", () => {
    const small = render(
      { totals: { ...plainTotals, main: { cost: 9.99, tokens: 162_400 } } },
      { width: 80 },
    )[2];
    const large = render(
      { totals: { ...plainTotals, main: { cost: 10, tokens: 162_400 } } },
      { width: 80 },
    )[2];
    const left = (line: string) => line.slice(0, line.indexOf("  "));

    expect(left(small)).toBe(left(large));
    expect(plainTheme.width(large)).toBe(80);
  });

  it("never draws a line wider than the width", () => {
    const patch = { ...full, sessionName: "a-long-session-name" };

    [30, 40, 60, 80].forEach((width) => {
      render(patch, { branch: "a-long-branch-name", width }).forEach((line) => {
        expect(plainTheme.width(line)).toBeLessThanOrEqual(width);
      });
    });
  });

  it("drops segments monotonically and keeps the ones that never drop", () => {
    const patch = { ...full, totals: { ...withAgents, subscription: true }, thinking: "high" };
    const line1 = ["refactor", "thinking", "on main"];
    const line2 = ["tokens", "subscription", "cache", "agents", "of 1M"];
    const keep1 = ["my-project", "test-model"];
    const keep2 = ["context 15%", "$4.42"];
    const lines = (width: number) => render(patch, { branch: "main", width });

    widths.slice(1).forEach((width, index) => {
      const wider = lines(widths[index]);
      const narrower = lines(width);

      expect(
        present([narrower[1]], line1).every((marker) => present([wider[1]], line1).includes(marker)),
      ).toBe(true);
      expect(
        present([narrower[2]], line2).every((marker) => present([wider[2]], line2).includes(marker)),
      ).toBe(true);
    });

    const narrowest = lines(30);

    expect(present([narrowest[1]], keep1)).toEqual(keep1);
    expect(present([narrowest[2]], keep2)).toEqual(keep2);

    const lostAt = (index: number, marker: string) =>
      widths.find((width) => !lines(width)[index].includes(marker)) ?? 0;

    expect(lostAt(1, "refactor")).toBeGreaterThanOrEqual(lostAt(1, "thinking"));
    expect(lostAt(1, "thinking")).toBeGreaterThanOrEqual(lostAt(1, "on main"));
    expect(lostAt(2, "tokens")).toBeGreaterThanOrEqual(lostAt(2, "subscription"));
    expect(lostAt(2, "subscription")).toBeGreaterThanOrEqual(lostAt(2, "cache"));
    expect(lostAt(2, "cache")).toBeGreaterThanOrEqual(lostAt(2, "agents"));
    expect(lostAt(2, "agents")).toBeGreaterThanOrEqual(lostAt(2, "of 1M"));
  });

  it("drops the total label together with the split", () => {
    widths.forEach((width) => {
      const line = lineAt(2, { totals: withAgents }, width);

      expect(line.includes("total")).toBe(line.includes("agents"));
    });
  });

  it("cuts the left side when the never-drop segments do not fit", () => {
    const line = lineAt(1, { cwd: "/work/a-very-long-project-folder-name" }, 20);

    expect(plainTheme.width(line)).toBeLessThanOrEqual(20);
  });
});

describe("renderFooter hint row", () => {
  const agents = new Map([[AGENTS_HINT_KEY, "← to list agents"]]);

  it("holds the cycle pair alone without an agents status", () => {
    const lines = render();

    expect(lines[3]).toContain("shift+tab to cycle thinking");
    expect(lines[3]).not.toContain("list agents");
  });

  it("puts the agents pair after the cycle pair and never repeats it as a status line", () => {
    const lines = render({}, { statuses: agents });

    expect(lines[3]).toMatch(/shift\+tab to cycle thinking · ← to list agents/);
    expect(lines.filter((line) => line.includes("list agents"))).toHaveLength(1);
  });

  it("drops the cycle pair first at a narrow width", () => {
    const rows = widths.map((width) => render({}, { statuses: agents, width })[3]);
    const cycleOnly = rows.some((row) => row.includes("cycle") && !row.includes("list agents"));
    const agentsOnly = rows.some((row) => row.includes("list agents") && !row.includes("cycle"));

    expect(cycleOnly).toBe(false);
    expect(agentsOnly).toBe(true);
  });

  it("omits the row for a model without reasoning and no agents status", () => {
    const noReasoning = { model: { ...model, reasoning: false } };
    const bare = render(noReasoning);

    expect(bare).toHaveLength(render().length - 1);
    expect(render(noReasoning, { statuses: agents })[3]).toBe(" ← to list agents");
  });

  it("lists one line per status by key, collapses whitespace and skips the spending status", () => {
    const statuses = new Map([
      ["zeta", "last"],
      [SPENDING_STATUS_KEY, "main $1.000 · total $1.000"],
      ["alpha", "  first\n  line "],
      ["empty", "   "],
    ]);

    expect(render({}, { statuses }).slice(-4)).toEqual(["", " first line", " last", ""]);
    expect(render({}, { statuses: new Map([[SPENDING_STATUS_KEY, "main $1.000"]]) })).toEqual(render());
  });
});

describe("renderFooter while working", () => {
  it("keeps the same height whatever the figures", () => {
    const idle = render(full, { branch: "main", width: 80 });
    const working = render(
      { ...full, context: { tokens: 990_000, window: 1_000_000, percent: 99 }, cache: 5 },
      { branch: "main", width: 80 },
    );

    expect(working).toHaveLength(idle.length);
  });
});

describe("renderFooter with handoff limits", () => {
  const limits = { softRatio: 0.45, hardRatio: 0.6, softTokens: 125_000, hardTokens: 175_000 };
  const window = 272_000;
  const withLimits = (tokens: number): Partial<FooterState> => ({
    context: { tokens, window, percent: (tokens / window) * 100 },
    limits,
  });

  it("measures the context against the handoff point", () => {
    const { painted } = paint(withLimits(120_000));

    expect(painted).toContainEqual({ token: "text", text: "74%" });
    expect(painted).toContainEqual({ token: "dim", text: "of 163k" });
  });

  it("warns at the soft threshold and errors in bold at the hard one", () => {
    const warn = paint(withLimits(122_400));
    const error = paint(withLimits(163_200));

    expect(warn.painted).toContainEqual({ token: "warning", text: "75%" });
    expect(warn.bolded).toEqual([]);
    expect(error.painted).toContainEqual({ token: "error", text: "100%" });
    expect(error.painted).toContainEqual({ token: "error", text: "of 163k" });
    expect(error.painted).toContainEqual({ token: "error", text: "163,200" });
    expect(error.bolded).toEqual(expect.arrayContaining(["163,200", "100%"]));
  });

  it("lets the percentage pass 100", () => {
    expect(render(withLimits(170_000))[2]).toContain("context 170,000 · 104% of 163k");
  });

  it("falls back to the window without limits", () => {
    const patch = { context: { tokens: 120_000, window, percent: 44 } };

    expect(render(patch)[2]).toContain("context 120,000 · 44% of 272k");
    expect(paint({ context: { tokens: 190_400, window, percent: 70 } }).painted).toContainEqual({
      token: "warning",
      text: "70%",
    });
  });
});
