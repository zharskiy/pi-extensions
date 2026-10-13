import { describe, expect, it } from "vitest";
import type { ThemeLike } from "../../../core/adapter/contract.ts";
import { SPENDING_STATUS_KEY, type SpendingTotals } from "../../../core/manager/channels.ts";
import { plainTheme } from "../../../core/test/helpers/fakes.ts";
import {
  type FooterState,
  formatCost,
  formatTokens,
  formatWindow,
  modeLine,
  placeLine,
  renderFooter,
  sessionLine,
  statsLine,
  statusLine,
} from "../src/render.ts";

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

const plain = (text: string) => text.replace(ANSI, "");

const tokenTheme: ThemeLike = { fg: (token, text) => `<${token}>${text}`, bold: (text) => text };

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
  ...patch,
});

const render = (patch: Partial<FooterState> = {}, branch: string | null = null, statuses = new Map()) =>
  renderFooter(plainTheme, state(patch), { branch, statuses }).map(plain);

describe("format helpers", () => {
  it("formats token counts", () => {
    expect([999, 1000, 150_100, 1_000_000, 2_450_000].map(formatTokens)).toEqual([
      "999",
      "1.0k",
      "150.1k",
      "1.0M",
      "2.5M",
    ]);
  });

  it("formats costs", () => {
    expect([0, -1, 0.004, 0.01, 4, 4.425].map(formatCost)).toEqual([
      "$0.00",
      "$0.00",
      "$0.004",
      "$0.01",
      "$4.00",
      "$4.42",
    ]);
  });

  it("formats context windows", () => {
    expect([512, 200_000, 128_500, 1_000_000, 1_500_000].map(formatWindow)).toEqual([
      "512",
      "200k",
      "129k",
      "1M",
      "1.5M",
    ]);
  });
});

describe("line builders", () => {
  it("shows context tokens, main cost and the model with its window", () => {
    const line = statsLine(plainTheme, state().context, model, 4);

    expect(plain(line)).toBe("150.1k · $4.00 · test-model (1M context)");
  });

  it("colours the context tokens by occupancy", () => {
    const at = (percent: number) => statsLine(tokenTheme, { tokens: 1000, window: 2000, percent }, model, 0);

    expect(at(95)).toContain("<error>1.0k");
    expect(at(80)).toContain("<warning>1.0k");
    expect(at(50)).not.toMatch(/<(error|warning)>/);
  });

  it("marks unknown context and a missing model", () => {
    expect(plain(statsLine(plainTheme, { tokens: null, window: 0, percent: null }, undefined, 0))).toBe(
      "? · $0.00 · no model",
    );
  });

  it("adds every source to the session total", () => {
    expect(plain(sessionLine(plainTheme, totals))).toBe("Session total (agents included): 162.4k / $4.42");
  });

  it("marks subscription sessions on the session total", () => {
    const sub = { ...totals, subscription: true };

    expect(plain(sessionLine(plainTheme, sub))).toBe("Session total (agents included): 162.4k / $4.42 (sub)");
    expect(sessionLine(tokenTheme, sub)).toContain("<dim> (sub)");
  });

  it("leaves the cost out of the stats line when it is unknown", () => {
    expect(plain(statsLine(plainTheme, state().context, model, undefined))).toBe(
      "150.1k · test-model (1M context)",
    );
  });

  it("shows the folder and the session name", () => {
    expect(plain(placeLine(plainTheme, "/work/my-project/", undefined))).toBe("my-project");
    expect(plain(placeLine(plainTheme, "C:\\work\\my-project", "refactor"))).toBe("my-project • refactor");
  });

  it("shows the thinking level with the key that cycles it", () => {
    expect(plain(modeLine(plainTheme, model, "high", "shift+tab"))).toBe(
      "▶▶ thinking high (shift+tab to cycle)",
    );
    expect(plain(modeLine(plainTheme, model, "", "shift+tab"))).toBe("▶▶ thinking off (shift+tab to cycle)");
    expect(plain(modeLine(plainTheme, { ...model, reasoning: false }, "high", "shift+tab"))).toBe(
      "▶▶ thinking unavailable (shift+tab to cycle)",
    );
  });

  it("joins statuses by key, collapses whitespace and skips the spending status", () => {
    const statuses = new Map([
      ["zeta", "last"],
      [SPENDING_STATUS_KEY, "main $1.000 · total $1.000"],
      ["alpha", "  first\n  line "],
      ["empty", "   "],
    ]);

    expect(statusLine(statuses)).toBe("first line last");
    expect(statusLine(new Map([[SPENDING_STATUS_KEY, "main $1.000"]]))).toBeUndefined();
  });
});

describe("renderFooter", () => {
  it("renders the padded block followed by a blank line", () => {
    expect(render()).toEqual([
      " 150.1k · $4.00 · test-model (1M context)",
      " Session total (agents included): 162.4k / $4.42",
      " my-project",
      " ▶▶ thinking high (shift+tab to cycle)",
      "",
    ]);
  });

  it("adds the branch, the session name and the statuses", () => {
    const lines = render({ sessionName: "refactor" }, "feature-branch", new Map([["other", "busy"]]));

    expect(lines).toEqual([
      " 150.1k · $4.00 · test-model (1M context)",
      " Session total (agents included): 162.4k / $4.42",
      " my-project • refactor",
      " feature-branch",
      " ▶▶ thinking high (shift+tab to cycle)",
      "",
      " busy",
      "",
    ]);
  });

  it("hides the cost and the session total until spending publishes", () => {
    expect(render({ totals: undefined })).toEqual([
      " 150.1k · test-model (1M context)",
      " my-project",
      " ▶▶ thinking high (shift+tab to cycle)",
      "",
    ]);
  });
});
