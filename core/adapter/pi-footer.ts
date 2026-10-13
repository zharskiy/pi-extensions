import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import type { Host, HostUi, ThemeLike, WidgetHandle } from "./contract.ts";
import type { HostState } from "./pi-ui.ts";
import { contextOf } from "./usage.ts";

export const createFooterSetter = (
  tuiCtx: () => ExtensionContext | undefined,
  themeOf: (theme: Theme) => ThemeLike,
): HostUi["setFooter"] => {
  let footerTui: TUI | undefined;
  const handle: WidgetHandle = { refresh: () => footerTui?.requestRender() };

  return (render) => {
    const ctx = tuiCtx();

    if (!ctx) {
      return handle;
    }

    if (!render) {
      footerTui = undefined;
      ctx.ui.setFooter(undefined);
      return handle;
    }

    ctx.ui.setFooter((tui, theme, footerData) => {
      const footerTheme = themeOf(theme);
      const ellipsis = theme.fg("dim", "…");
      const unsubscribe = footerData.onBranchChange(() => tui.requestRender());

      footerTui = tui;

      return {
        render: (width: number) =>
          render(width, footerTheme, {
            branch: footerData.getGitBranch(),
            statuses: footerData.getExtensionStatuses(),
          }).map((line) => truncateToWidth(line, width, ellipsis)),
        invalidate: () => {},
        dispose: () => {
          unsubscribe();

          if (footerTui === tui) {
            footerTui = undefined;
          }
        },
      };
    });

    return handle;
  };
};

export const footerHost = (
  pi: Pick<ExtensionAPI, "getThinkingLevel">,
  state: HostState,
): Pick<Host, "context" | "model" | "thinkingLevel" | "sessionName"> => ({
  context: () => contextOf({ getContextUsage: () => state.ctx?.getContextUsage() }),
  model: () => {
    const model = state.ctx?.model;

    if (!model) {
      return undefined;
    }

    return { name: model.name, contextWindow: model.contextWindow, reasoning: model.reasoning };
  },
  thinkingLevel: () => pi.getThinkingLevel(),
  sessionName: () => state.ctx?.sessionManager.getSessionName(),
});
