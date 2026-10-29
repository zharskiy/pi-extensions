import { describe, expect, it } from "vitest";
import { LIMITS_CHANNEL, TOTALS_CHANNEL } from "../../../platform/shared/index.ts";
import {
  createFakeAgentRuntime,
  createFakeHost,
  FAKE_FOOTER_KEY,
  plainTheme,
  startExtension,
} from "../../../test/framework/index.ts";
import footer from "../api/extension.ts";

const setup = () => {
  const host = createFakeHost({ cwd: "/work/my-project" });

  host.activeModel = { name: "test-model", reasoning: true };
  host.thinking = "medium";
  host.contextUsage = { tokens: 50_000, window: 200_000, percent: 25 };
  startExtension({ extension: footer, runtime: createFakeAgentRuntime(), host });

  const lines = () => host.footer?.(80, plainTheme, { branch: "main", statuses: new Map() }) ?? [];

  return { host, lines };
};

describe("footer", () => {
  it("installs the footer below the editor and hides the cost figures until spending publishes", () => {
    const { host, lines } = setup();

    expect(host.belowEditor).toEqual([FAKE_FOOTER_KEY]);
    expect(lines()).toEqual([
      "",
      " my-project on main                                 test-model · thinking medium",
      " context 50.0k of 200k",
      " <app.thinking.cycle> to cycle thinking",
      "",
    ]);
  });

  it("shows the session cache hit read on each render once the session reported cache activity", () => {
    const { host, lines } = setup();

    host.mainUsage = { input: 1_000, cacheRead: 0, cacheWrite: 0, output: 10 };

    expect(lines()[2]).not.toContain("cache");

    host.mainUsage = { input: 100, cacheRead: 870, cacheWrite: 30, output: 10 };

    expect(lines()[2]).toBe(" context 50.0k of 200k · cache 87%");
  });

  it("shows the published totals and refreshes", () => {
    const { host, lines } = setup();

    host.emit(TOTALS_CHANNEL, {
      main: { cost: 1.5, tokens: 40_000 },
      sources: [{ source: "agents", cost: 0.5, tokens: 10_000 }],
      subscription: false,
    });

    expect(host.footerRefreshes).toBe(1);
    expect(lines()[2]).toBe(
      " context 50.0k of 200k    50.0k tokens · $1.50 main · $0.50 agents · $2.00 total",
    );
  });

  it("ignores malformed totals", () => {
    const { host, lines } = setup();

    host.emit(TOTALS_CHANNEL, { main: { cost: -1, tokens: 0 }, sources: [], subscription: false });
    host.emit(TOTALS_CHANNEL, {
      main: { cost: 1, tokens: 0 },
      sources: [{ cost: 1, tokens: 0 }],
      subscription: false,
    });
    host.emit(TOTALS_CHANNEL, { main: { cost: 1, tokens: 0 }, sources: [] });
    host.emit(TOTALS_CHANNEL, null);

    expect(host.footerRefreshes).toBe(0);
    expect(lines()[2]).toBe(" context 50.0k of 200k");
  });

  it("refreshes on idle", () => {
    const { host } = setup();

    host.settle();

    expect(host.footerRefreshes).toBe(1);
  });

  it("reads the live context, model, thinking level and session name on each render", () => {
    const { host, lines } = setup();

    host.contextUsage = { tokens: 190_000, window: 200_000, percent: 95 };
    host.thinking = "high";
    host.sessionTitle = "refactor";

    expect(lines()[1]).toContain("my-project on main · refactor");
    expect(lines()[1]).toContain("test-model · thinking high");
    expect(lines()[2]).toBe(" context 190.0k of 200k");
  });
});

describe("footer handoff limits", () => {
  const limits = { softRatio: 0.45, hardRatio: 0.6, softTokens: 125_000, hardTokens: 175_000 };

  it("shows the context against the handoff point once session-limits publishes", () => {
    const { host, lines } = setup();

    expect(lines()[2]).toBe(" context 50.0k of 200k");

    host.emit(LIMITS_CHANNEL, limits);

    expect(host.footerRefreshes).toBe(1);
    expect(lines()[2]).toBe(" working context 50.0k of 120k");
  });

  it("ignores malformed limits", () => {
    const { host, lines } = setup();

    host.emit(LIMITS_CHANNEL, { ...limits, hardRatio: 2 });
    host.emit(LIMITS_CHANNEL, null);

    expect(host.footerRefreshes).toBe(0);
    expect(lines()[2]).toBe(" context 50.0k of 200k");
  });
});
