import type {
  ExtensionAPI,
  ExtensionContext,
  ReadonlyFooterDataProvider,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import { contextOf } from "../context/usage-math.ts";
import type { ContextSnapshot } from "../types/context.ts";
import type { SessionHost } from "../types/host-capabilities.ts";
import type { WidgetUi } from "../types/host-ui.ts";
import type { FooterData, FooterRender, WidgetHandle } from "../types/view.ts";
import { drawNoticesIn, noticeLines, syncNotices } from "./notices.ts";
import { themeLike } from "./theme-bridge.ts";
import type { HostState } from "./tui-context.ts";

export const FOOTER_WIDGET_KEY = "pi-footer";

export const createFooterSetter = (tuiCtx: () => ExtensionContext | undefined): WidgetUi["setFooter"] => {
  let footerTui: TUI | undefined;
  let widgetTui: TUI | undefined;
  let footerData: ReadonlyFooterDataProvider | undefined;
  let current: FooterRender | undefined;
  const handle: WidgetHandle = {
    refresh: () => (widgetTui ?? footerTui)?.requestRender(),
  };

  const dataOf = (data: ReadonlyFooterDataProvider | undefined): FooterData => ({
    branch: data?.getGitBranch() ?? null,
    statuses: data?.getExtensionStatuses() ?? new Map(),
  });

  const draw = (width: number, theme: Theme, data: ReadonlyFooterDataProvider | undefined) =>
    [...noticeLines(), ...(current?.(width, themeLike(theme), dataOf(data)) ?? [])].map((line) =>
      truncateToWidth(line, width, theme.fg("dim", "...")),
    );

  const mountFooter = (ctx: ExtensionContext) => {
    ctx.ui.setFooter((tui, _theme, data) => {
      const unsubscribe = data.onBranchChange(() => tui.requestRender());

      footerTui = tui;
      footerData = data;

      return {
        render: () => [],
        invalidate: () => {},
        dispose: () => {
          unsubscribe();

          if (footerTui === tui) {
            footerTui = undefined;
            footerData = undefined;
          }
        },
      };
    });
  };

  const removeWidget = (ctx: ExtensionContext) => {
    if (widgetTui) {
      widgetTui = undefined;
      ctx.ui.setWidget(FOOTER_WIDGET_KEY, undefined);
    }
  };

  const mountWidget = (ctx: ExtensionContext) => {
    ctx.ui.setWidget(
      FOOTER_WIDGET_KEY,
      (tui, theme) => {
        const stopNotices = drawNoticesIn({ refresh: () => tui.requestRender() });

        widgetTui = tui;

        return {
          render: (width: number) => draw(width, theme, footerData),
          invalidate: () => {},
          dispose: () => {
            stopNotices();

            if (widgetTui === tui) {
              widgetTui = undefined;
            }
          },
        };
      },
      { placement: "belowEditor" },
    );
  };

  return (render) => {
    const ctx = tuiCtx();

    if (!ctx) {
      return handle;
    }

    current = render;

    if (!render) {
      removeWidget(ctx);
      footerTui = undefined;
      ctx.ui.setFooter(undefined);
      syncNotices(ctx);
      return handle;
    }

    if (widgetTui) {
      handle.refresh();
      return handle;
    }

    mountFooter(ctx);
    mountWidget(ctx);
    syncNotices(ctx);

    return handle;
  };
};

type ContextCache = { leaf: string | null; model: ExtensionContext["model"]; snapshot: ContextSnapshot };

export const footerHost = (
  pi: Pick<ExtensionAPI, "getThinkingLevel">,
  state: HostState,
): Pick<SessionHost, "context" | "model" | "thinkingLevel" | "sessionName"> => {
  let cache: ContextCache | undefined;

  const context = () => {
    const ctx = state.ctx;

    if (!ctx) {
      cache = undefined;
      return contextOf({ getContextUsage: () => undefined });
    }

    const leaf = ctx.sessionManager.getLeafId();

    if (cache && cache.leaf === leaf && cache.model === ctx.model) {
      return cache.snapshot;
    }

    cache = { leaf, model: ctx.model, snapshot: contextOf(ctx) };

    return cache.snapshot;
  };

  return {
    context,
    model: () => {
      const model = state.ctx?.model;

      if (!model) {
        return undefined;
      }

      return { name: model.name, contextWindow: model.contextWindow, reasoning: model.reasoning };
    },
    thinkingLevel: () => (state.ctx ? (state.ctx.thinkingLevel ?? pi.getThinkingLevel()) : "off"),
    sessionName: () => state.ctx?.sessionManager.getSessionName(),
  };
};
