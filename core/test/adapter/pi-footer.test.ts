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

  it("paints the ellipsis with the current theme on each render", () => {
    const { installed, setFooter, tui } = fakeFooter("tui");
    const theme = { fg: (_token: string, text: string) => text };

    setFooter(() => ["0123456789"]);

    const component = installed.at(-1)?.(tui, theme, {
      getGitBranch: () => null,
      getExtensionStatuses: () => new Map(),
      onBranchChange: () => () => {},
    });

    theme.fg = (_token, text) => `\x1b[2m${text}\x1b[0m`;

    const [line = ""] = component?.render(6) ?? [];

    expect(line).toContain("\x1b[2m…");
    expect(line.replace(ANSI, "")).toBe("01234…");
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
        sessionManager: { getSessionName: () => "refactor", getLeafId: () => "leaf-1" },
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
    expect(host.thinkingLevel()).toBe("off");
  });

  it("prefers the context's thinking level", () => {
    const state: HostState = {
      ctx: { thinkingLevel: "low", sessionManager: {} } as unknown as ExtensionContext,
    };

    expect(footerHost({ getThinkingLevel: () => "high" }, state).thinkingLevel()).toBe("low");
  });

  it("reuses the context usage until the leaf or the model changes", () => {
    const session = { leaf: "leaf-1", calls: 0 };
    const ctx = {
      model: { name: "a", contextWindow: 100, reasoning: false },
      getContextUsage: () => {
        session.calls += 1;
        return { tokens: session.calls, contextWindow: 100, percent: 1 };
      },
      sessionManager: { getLeafId: () => session.leaf },
    };
    const host = footerHost({ getThinkingLevel: () => "off" }, { ctx: ctx as unknown as ExtensionContext });

    host.context();

    expect(host.context().tokens).toBe(1);
    expect(session.calls).toBe(1);

    session.leaf = "leaf-2";

    expect(host.context().tokens).toBe(2);

    ctx.model = { ...ctx.model };

    expect(host.context().tokens).toBe(3);
    expect(host.context().tokens).toBe(3);
    expect(session.calls).toBe(3);
  });
});
