import { describe, expect, it } from "vitest";
import { TOTALS_CHANNEL } from "../../../core/manager/channels.ts";
import { createFakeHost, FAKE_FOOTER_KEY, plainTheme } from "../../../core/test/helpers/fakes.ts";
import { createFooter } from "../src/footer.ts";

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

const setup = () => {
  const host = createFakeHost({ cwd: "/work/my-project" });

  host.activeModel = { name: "test-model", contextWindow: 200_000, reasoning: true };
  host.thinking = "medium";
  host.contextUsage = { tokens: 50_000, window: 200_000, percent: 25 };
  createFooter(host);
  host.start();

  const lines = () =>
    (host.footer?.(80, plainTheme, { branch: "main", statuses: new Map() }) ?? []).map((line) =>
      line.replace(ANSI, ""),
    );

  return { host, lines };
};

describe("footer", () => {
  it("installs the footer below the editor and hides the cost figures until spending publishes", () => {
    const { host, lines } = setup();

    expect(host.belowEditor).toEqual([FAKE_FOOTER_KEY]);
    expect(lines()).toEqual([
      "",
      " 50.0k · test-model (200k context)",
      " my-project git:(main)",
      " ▶▶ thinking medium (<app.thinking.cycle> to cycle)",
      " ← to agents",
      "",
    ]);
  });

  it("shows the published totals and refreshes", () => {
    const { host, lines } = setup();

    host.emit(TOTALS_CHANNEL, {
      main: { cost: 1.5, tokens: 40_000 },
      sources: [{ source: "agents", cost: 0.5, tokens: 10_000 }],
      subscription: false,
    });

    expect(host.footerRefreshes).toBe(1);
    expect(lines().slice(1, 3)).toEqual([
      " 50.0k · $1.50 · test-model (200k context)",
      " Session total (agents included): 50.0k / $2.00",
    ]);
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
    expect(lines().slice(1, 3)).toEqual([" 50.0k · test-model (200k context)", " my-project git:(main)"]);
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

    expect(lines()).toContain(" 190.0k · test-model (200k context)");
    expect(lines()).toContain(" my-project git:(main) • refactor");
    expect(lines()).toContain(" ▶▶ thinking high (<app.thinking.cycle> to cycle)");
  });
});
