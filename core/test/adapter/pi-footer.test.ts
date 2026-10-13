import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createFooterSetter, footerHost } from "../../adapter/pi-footer.ts";
import type { HostState } from "../../adapter/pi-ui.ts";
import { plainTheme } from "../helpers/fakes.ts";

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

type Factory = (
  tui: unknown,
  theme: unknown,
  data: unknown,
) => { render(width: number): string[]; dispose(): void };

const fakeFooter = (mode: string) => {
  const installed: (Factory | undefined)[] = [];
  const branchListeners = new Set<() => void>();
  const tui = { renders: 0, requestRender: () => (tui.renders += 1) };
  const ctx = { mode, ui: { setFooter: (factory: Factory | undefined) => installed.push(factory) } };
  const data = {
    getGitBranch: () => "main",
    getExtensionStatuses: () => new Map([["k", "v"]]),
    onBranchChange: (listener: () => void) => {
      branchListeners.add(listener);
      return () => branchListeners.delete(listener);
    },
  };
  const setFooter = createFooterSetter(
    () => (ctx.mode === "tui" ? (ctx as unknown as ExtensionContext) : undefined),
    () => plainTheme,
  );
  const mount = () => installed.at(-1)?.(tui, { fg: (_token: string, text: string) => text }, data);

  return { installed, branchListeners, tui, setFooter, mount };
};

describe("setFooter", () => {
  it("does nothing outside tui mode", () => {
    const { installed, setFooter } = fakeFooter("rpc");

    expect(() => setFooter(() => ["x"]).refresh()).not.toThrow();
    expect(installed).toEqual([]);
  });

  it("renders with the branch and statuses and truncates every line to the width", () => {
    const { setFooter, mount } = fakeFooter("tui");

    setFooter((_width, _theme, { branch, statuses }) => [`${branch} ${statuses.get("k")}`, "0123456789"]);

    expect(
      mount()
        ?.render(6)
        .map((line) => line.replace(ANSI, "")),
    ).toEqual(["main v", "01234…"]);
  });

  it("re-renders on branch changes and refresh, and unsubscribes on dispose", () => {
    const { setFooter, mount, tui, branchListeners } = fakeFooter("tui");
    const handle = setFooter(() => []);
    const component = mount();

    branchListeners.forEach((listener) => {
      listener();
    });
    handle.refresh();

    expect(tui.renders).toBe(2);

    component?.dispose();
    handle.refresh();

    expect(branchListeners.size).toBe(0);
    expect(tui.renders).toBe(2);
  });

  it("restores pi's footer when cleared", () => {
    const { installed, setFooter } = fakeFooter("tui");

    setFooter(undefined);

    expect(installed).toEqual([undefined]);
  });
});

describe("footerHost", () => {
  it("maps the live context, model, thinking level and session name", () => {
    const state: HostState = {
      ctx: {
        model: { name: "test-model", contextWindow: 200_000, reasoning: true, id: "x" },
        getContextUsage: () => ({ tokens: 1_000, contextWindow: 200_000, percent: 0.5 }),
        sessionManager: { getSessionName: () => "refactor" },
      } as unknown as ExtensionContext,
    };
    const host = footerHost({ getThinkingLevel: () => "high" }, state);

    expect(host.context()).toEqual({ tokens: 1_000, window: 200_000, percent: 0.5 });
    expect(host.model()).toEqual({ name: "test-model", contextWindow: 200_000, reasoning: true });
    expect(host.thinkingLevel()).toBe("high");
    expect(host.sessionName()).toBe("refactor");

    state.ctx = undefined;

    expect(host.context()).toEqual({ tokens: null, window: 0, percent: null });
    expect(host.model()).toBeUndefined();
    expect(host.sessionName()).toBeUndefined();
  });
});
