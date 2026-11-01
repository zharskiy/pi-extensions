import { existsSync } from "node:fs";
import { homedir } from "node:os";
import type { ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { readSessionBranch } from "../runtime/session-file.ts";
import type { ThemeLike, ThemeToken } from "../types/theme.ts";
import type { AnyToolSpec } from "../types/tools.ts";
import type { EntryRender } from "../types/view.ts";
import { createTranscriptPane } from "./transcript.ts";

export const PREVIOUS_SESSION_TYPE = "pi-adapter:previous-session";

const MAX_SESSIONS = 5;

type PreviousSession = { file: string; leafId: string | null };

type Part = { token: ThemeToken; text: string; pane?: ReturnType<typeof createTranscriptPane> };

type RendererDeps = {
  cwd(): string;
  tools(): AnyToolSpec[];
  requestRender(): void;
};

const isPreviousSession = (value: unknown): value is PreviousSession =>
  typeof (value as Partial<PreviousSession> | undefined)?.file === "string";

const readBranch = (previous: PreviousSession) => {
  if (!existsSync(previous.file)) {
    return undefined;
  }

  try {
    return readSessionBranch(previous.file, previous.leafId);
  } catch {
    return undefined;
  }
};

const shownPath = (file: string) => {
  const home = homedir();

  return file.startsWith(`${home}/`) ? `~${file.slice(home.length)}` : file;
};

export const showPreviousSession = (ctx: ExtensionContext) => {
  const file = ctx.sessionManager.getSessionFile();

  if (!file) {
    return undefined;
  }

  const previous: PreviousSession = { file, leafId: ctx.sessionManager.getLeafId() };

  return async (sessionManager: SessionManager) => {
    sessionManager.appendCustomEntry(PREVIOUS_SESSION_TYPE, previous);
  };
};

export const previousSessionRenderer = (deps: RendererDeps) => {
  const cache = new Map<string, Part[]>();
  const applied = new WeakMap<object, boolean>();
  let building = false;
  let current: ThemeLike;

  const tui = {
    requestRender: () => {
      if (!building) {
        deps.requestRender();
      }
    },
  } as unknown as TUI;

  const sessionParts = (previous: PreviousSession, seen: string[]): { parts: Part[]; read: boolean } => {
    const path = shownPath(previous.file);

    if (seen.includes(previous.file) || seen.length >= MAX_SESSIONS) {
      return { parts: [{ token: "dim", text: `» earlier sessions not shown · ${path}` }], read: true };
    }

    const items = readBranch(previous);

    if (!items) {
      return { parts: [{ token: "warning", text: `» previous session not found · ${path}` }], read: false };
    }

    const earlier = items
      .flatMap((item) =>
        item.kind === "entry" && item.customType === PREVIOUS_SESSION_TYPE ? [item.data] : [],
      )
      .find(isPreviousSession);

    const nested = earlier ? sessionParts(earlier, [...seen, previous.file]).parts : [];
    const pane = createTranscriptPane(tui, deps.cwd(), {
      tools: deps.tools(),
      theme: () => current,
    });

    pane.sync(items);

    return { parts: [...nested, { token: "dim", text: `» previous session · ${path}`, pane }], read: true };
  };

  const partsFor = (previous: PreviousSession) => {
    const key = `${previous.file}\n${previous.leafId}`;
    const cached = cache.get(key);

    if (cached) {
      return cached;
    }

    building = true;

    try {
      const { parts, read } = sessionParts(previous, []);

      if (read) {
        cache.set(key, parts);
      }

      return parts;
    } finally {
      building = false;
    }
  };

  const render: EntryRender = (data, width, expanded, theme, pad) => {
    if (!isPreviousSession(data)) {
      return [];
    }

    const parts = partsFor(data);
    const margin = " ".repeat(pad);

    current = theme;

    return parts.flatMap(({ token, text, pane }, index) => {
      if (pane && applied.get(pane) !== expanded) {
        applied.set(pane, expanded);
        pane.setToolsExpanded(expanded);
      }

      return [
        ...(index > 0 ? [""] : []),
        `${margin}${theme.fg(token, text)}`,
        ...(pane?.render(width) ?? []),
      ];
    });
  };

  const invalidate = () => {
    cache.forEach((parts) => {
      parts.forEach(({ pane }) => {
        pane?.invalidate();
      });
    });
  };

  return { render, invalidate };
};
