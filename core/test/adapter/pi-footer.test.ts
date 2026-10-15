import { type ExtensionContext, InteractiveMode } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { createEditorHooks } from "../../adapter/pi-editor.ts";
import { createFooterSetter, FOOTER_WIDGET_KEY, footerHost } from "../../adapter/pi-footer.ts";
import { createUi, type HostState } from "../../adapter/pi-ui.ts";
import { initRenderTheme } from "./render-theme.ts";

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

type Factory = (
  tui: unknown,
  theme: unknown,
  data: unknown,
) => { render(width: number): string[]; dispose(): void };

type WidgetFactory = (tui: unknown, theme: unknown) => { render(width: number): string[]; dispose(): void };

const fakeFooter = (mode: string) => {
  const installed: (Factory | undefined)[] = [];
  const widgets: { key: string; factory: WidgetFactory | undefined; placement?: string }[] = [];
  const branchListeners = new Set<() => void>();
  const tui = { renders: 0, requestRender: () => (tui.renders += 1) };
  const ctx = {
    mode,
    ui: {
      setFooter: (factory: Factory | undefined) => installed.push(factory),
      setWidget: (key: string, factory: WidgetFactory | undefined, options?: { placement?: string }) =>
        widgets.push({ key, factory, placement: options?.placement }),
    },
  };
  const data = {
    getGitBranch: () => "main",
    getExtensionStatuses: () => new Map([["k", "v"]]),
    onBranchChange: (listener: () => void) => {
      branchListeners.add(listener);
      return () => branchListeners.delete(listener);
    },
  };
  const setFooter = createFooterSetter(() =>
    ctx.mode === "tui" ? (ctx as unknown as ExtensionContext) : undefined,
  );
  const mount = () => installed.at(-1)?.(tui, { fg: (_token: string, text: string) => text }, data);

  const mountWidget = () => widgets.at(-1)?.factory?.(tui, { fg: (_token: string, text: string) => text });

  return { installed, widgets, branchListeners, tui, setFooter, mount, mountWidget };
};

describe("setFooter", () => {
  it("does nothing outside tui mode", () => {
    const { installed, widgets, setFooter } = fakeFooter("rpc");

    expect(() => setFooter(() => ["x"]).refresh()).not.toThrow();
    expect(installed).toEqual([]);
    expect(widgets).toEqual([]);
  });

  it("draws the block as a below-editor widget with the branch and statuses, cut to the width, and leaves pi's footer slot empty", () => {
    const { installed, widgets, setFooter, mount, mountWidget } = fakeFooter("tui");

    setFooter((_width, _theme, { branch, statuses }) => [`${branch} ${statuses.get("k")}`, "0123456789"]);

    expect(installed).toHaveLength(1);
    expect(widgets.map(({ key, placement }) => ({ key, placement }))).toEqual([
      { key: FOOTER_WIDGET_KEY, placement: "belowEditor" },
    ]);
    expect(mount()?.render(6)).toEqual([]);
    expect(
      mountWidget()
        ?.render(6)
        .map((line) => line.replace(ANSI, "")),
    ).toEqual(["main v", "01234…"]);
  });

  it("paints the ellipsis with the current theme on each render", () => {
    const { setFooter, widgets, tui } = fakeFooter("tui");
    const theme = { fg: (_token: string, text: string) => text };

    setFooter(() => ["0123456789"]);

    const component = widgets.at(-1)?.factory?.(tui, theme);

    theme.fg = (_token, text) => `\x1b[2m${text}\x1b[0m`;

    const [line = ""] = component?.render(6) ?? [];

    expect(line).toContain("\x1b[2m…");
    expect(line.replace(ANSI, "")).toBe("01234…");
  });

  it("re-renders on refresh and branch changes without setting the widget again, and unsubscribes on dispose", () => {
    const { widgets, branchListeners, setFooter, mount, mountWidget, tui } = fakeFooter("tui");
    const handle = setFooter(() => ["a"]);
    const component = mountWidget();
    const footer = mount();

    const again = setFooter(() => ["b"]);

    expect(widgets).toHaveLength(1);
    expect(component?.render(10)).toEqual(["b"]);

    branchListeners.forEach((listener) => {
      listener();
    });
    handle.refresh();
    again.refresh();

    expect(tui.renders).toBe(4);

    footer?.dispose();

    expect(branchListeners.size).toBe(0);
  });

  it("sets the widget again once pi has disposed it", () => {
    const { widgets, setFooter, mountWidget } = fakeFooter("tui");

    setFooter(() => ["a"]);
    mountWidget()?.dispose();
    setFooter(() => ["a"]);

    expect(widgets).toHaveLength(2);
  });

  it("removes the widget and restores pi's footer when cleared", () => {
    const { installed, widgets, setFooter, mountWidget } = fakeFooter("tui");

    setFooter(() => ["a"]);
    mountWidget();
    setFooter(undefined);

    expect(widgets.at(-1)).toEqual({ key: FOOTER_WIDGET_KEY, factory: undefined, placement: undefined });
    expect(installed.at(-1)).toBeUndefined();
  });
});

describe("setFooter with pi's interactive layout", () => {
  const piLayout = () => {
    initRenderTheme();

    const mode = Object.assign(Object.create(InteractiveMode.prototype), {
      extensionWidgetsAbove: new Map(),
      extensionWidgetsBelow: new Map(),
      widgetContainerAbove: new Container(),
      widgetContainerBelow: new Container(),
      footerContainer: new Container(),
      footer: { render: () => ["pi footer"], invalidate: () => {} },
      footerDataProvider: {
        getGitBranch: () => "main",
        getExtensionStatuses: () => new Map([["pi-subagents", "← to agents"]]),
        onBranchChange: () => () => {},
      },
      ui: { requestRender: () => {} },
    }) as {
      setExtensionWidget(key: string, content: unknown, options?: unknown): void;
      setExtensionFooter(factory: unknown): void;
      clearExtensionWidgets(): void;
      widgetContainerBelow: Container;
      footerContainer: Container;
    };
    const state: HostState = {
      tools: new Map(),
      ctx: {
        mode: "tui",
        ui: {
          setWidget: (key: string, content: unknown, options?: unknown) =>
            mode.setExtensionWidget(key, content, options),
          setFooter: (factory: unknown) => mode.setExtensionFooter(factory),
        },
      } as unknown as ExtensionContext,
    };
    const ui = createUi(
      state,
      { write: () => {} },
      {},
      createEditorHooks(() => undefined),
    );
    const setFooter = createFooterSetter(() => state.ctx);
    const footer = () =>
      setFooter((_width, _theme, { statuses }) => ["usage", "thinking", statuses.get("pi-subagents") ?? ""]);
    const below = () => [...mode.widgetContainerBelow.render(40), ...mode.footerContainer.render(40)];
    const reset = () => {
      mode.setExtensionFooter(undefined);
      mode.clearExtensionWidgets();
    };

    mode.setExtensionFooter(undefined);

    return { ui, footer, below, reset, setFooter };
  };

  it("draws pi's own footer until the block is set, then nothing in the footer slot", () => {
    const { footer, below } = piLayout();

    expect(below()).toEqual(["pi footer"]);

    footer();

    expect(below()).toEqual(["usage", "thinking", "← to agents"]);
  });

  it("keeps the footer block above a panel set later, across a reset and a second set", () => {
    const { ui, footer, below, reset } = piLayout();

    footer();
    ui.setWidget("panel", () => ["panel row"]);
    footer();

    expect(below()).toEqual(["usage", "thinking", "← to agents", "panel row"]);

    reset();
    footer();
    ui.setWidget("panel", () => ["panel row"]);

    expect(below()).toEqual(["usage", "thinking", "← to agents", "panel row"]);
  });

  it("puts a panel set before the footer block above it", () => {
    const { ui, footer, below } = piLayout();

    ui.setWidget("panel", () => ["panel row"]);
    footer();

    expect(below()).toEqual(["panel row", "usage", "thinking", "← to agents"]);
  });
});

describe("footerHost", () => {
  it("maps the live context, model, thinking level and session name", () => {
    const state: HostState = {
      tools: new Map(),
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
      tools: new Map(),
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
    const host = footerHost(
      { getThinkingLevel: () => "off" },
      {
        tools: new Map(),
        ctx: ctx as unknown as ExtensionContext,
      },
    );

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
