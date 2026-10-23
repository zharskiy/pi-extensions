import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PAD } from "../manager/layout.ts";
import type { HostUi } from "./contract.ts";
import { fitLines } from "./pi-tools.ts";
import { type HostState, tuiContext } from "./pi-ui.ts";

export const NOTICE_WIDGET_KEY = "pi-notices";

type Redraw = { refresh(): void };

type NoticeBoard = { sources: Set<Map<string, string>>; footer?: Redraw; widget?: Redraw };

const BOARD_KEY = Symbol.for("pi-extensions.notices");

const shared = globalThis as typeof globalThis & { [BOARD_KEY]?: NoticeBoard };

const board = (): NoticeBoard => {
  shared[BOARD_KEY] ??= { sources: new Set() };

  return shared[BOARD_KEY];
};

export const noticeLines = (): string[] =>
  Array.from(new Map(Array.from(board().sources).flatMap((source) => Array.from(source))))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, text]) => PAD + text);

const mountNoticeWidget = (ctx: ExtensionContext, notices: NoticeBoard) => {
  ctx.ui.setWidget(
    NOTICE_WIDGET_KEY,
    (tui) => {
      const redraw: Redraw = { refresh: () => tui.requestRender() };

      notices.widget = redraw;

      return {
        render: (width: number) => fitLines(noticeLines(), width),
        invalidate: () => {},
        dispose: () => {
          if (notices.widget === redraw) {
            notices.widget = undefined;
          }
        },
      };
    },
    { placement: "belowEditor" },
  );
};

export const syncNotices = (ctx: ExtensionContext) => {
  const notices = board();

  if (notices.footer) {
    if (notices.widget) {
      ctx.ui.setWidget(NOTICE_WIDGET_KEY, undefined);
    }

    notices.footer.refresh();
    return;
  }

  if (notices.widget) {
    notices.widget.refresh();
    return;
  }

  mountNoticeWidget(ctx, notices);
};

export const drawNoticesIn = (redraw: Redraw) => {
  const notices = board();

  notices.footer = redraw;

  return () => {
    if (notices.footer === redraw) {
      notices.footer = undefined;
    }
  };
};

export type Notices = { setNotice: HostUi["setNotice"]; release(): void };

export const createNotices = (state: HostState): Notices => {
  const own = new Map<string, string>();
  const statuses = new Set<string>();

  return {
    setNotice: (key, text) => {
      const ctx = state.ctx;

      if (!ctx) {
        return;
      }

      const tui = tuiContext(state);

      if (!tui) {
        ctx.ui.setStatus(key, text);

        if (text) {
          statuses.add(key);
        } else {
          statuses.delete(key);
        }

        return;
      }

      if (own.get(key) === (text || undefined)) {
        return;
      }

      const sources = board().sources;

      sources.delete(own);
      sources.add(own);

      if (text) {
        own.set(key, text);
      } else {
        own.delete(key);
      }

      syncNotices(tui);
    },
    release: () => {
      const notices = board();

      statuses.forEach((key) => {
        state.ctx?.ui.setStatus(key, undefined);
      });
      statuses.clear();
      own.clear();
      notices.sources.delete(own);
      notices.footer?.refresh();
      notices.widget?.refresh();
    },
  };
};
