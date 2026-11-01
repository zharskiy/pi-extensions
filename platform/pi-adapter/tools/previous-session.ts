import { existsSync } from "node:fs";
import type { ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { readSessionBranch } from "../runtime/session-file.ts";
import type { ThemeLike, ThemeToken } from "../types/theme.ts";
import type { AnyToolSpec } from "../types/tools.ts";
import type { EntryRender } from "../types/view.ts";
import { labelledRule } from "../ui/rules.ts";
import { createTranscriptPane } from "./transcript.ts";

export const PREVIOUS_SESSION_TYPE = "pi-adapter:previous-session";

const MAX_SESSIONS = 5;

const DEFAULT_LABEL = "continued from previous session";

type PreviousSession = { file: string; leafId: string | null; label?: string };

type Part = { token: ThemeToken; label: string; pane?: ReturnType<typeof createTranscriptPane> };

type RendererDeps = {
  cwd(): string;
  tools(): AnyToolSpec[];
  requestRender(): void;
};

const isPreviousSession = (value: unknown): value is PreviousSession =>
  typeof (value as Partial<PreviousSession> | undefined)?.file === "string";

const labelOf = (previous: PreviousSession) =>
  typeof previous.label === "string" ? previous.label : DEFAULT_LABEL;

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

export const showPreviousSession = (ctx: ExtensionContext, label?: string) => {
  const file = ctx.sessionManager.getSessionFile();

  if (!file) {
    return undefined;
  }

  const previous: PreviousSession = { file, leafId: ctx.sessionManager.getLeafId(), label };

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

  const sessionParts = (previous: PreviousSession, seen: string[]): Part[] => {
    if (seen.includes(previous.file) || seen.length >= MAX_SESSIONS) {
      return [{ token: "dim", label: "earlier sessions not shown" }];
    }

    const branch = readBranch(previous);

    if (!branch) {
      return [{ token: "warning", label: "previous session not found" }];
    }

    const earlier = branch.custom
      .filter((entry) => entry.customType === PREVIOUS_SESSION_TYPE)
      .map((entry) => entry.data)
      .find(isPreviousSession);

    const nested = earlier ? sessionParts(earlier, [...seen, previous.file]) : [];
    const pane = createTranscriptPane(tui, deps.cwd(), {
      tools: deps.tools(),
      theme: () => current,
    });

    pane.sync(branch.items);

    return [...nested, { token: "dim", label: labelOf(previous), pane }];
  };

  const partsFor = (previous: PreviousSession) => {
    const key = `${previous.file}\n${previous.leafId}\n${labelOf(previous)}`;
    const cached = cache.get(key);

    if (cached) {
      return cached;
    }

    building = true;

    try {
      const parts = sessionParts(previous, []);

      cache.set(key, parts);

      return parts;
    } finally {
      building = false;
    }
  };

  const render: EntryRender = (data, width, expanded, theme, pad) => {
    if (!isPreviousSession(data)) {
      return [];
    }

    current = theme;

    const parts = partsFor(data);
    const margin = " ".repeat(pad);

    return parts.flatMap(({ token, label, pane }) => {
      if (pane && applied.get(pane) !== expanded) {
        applied.set(pane, expanded);
        pane.setToolsExpanded(expanded);
      }

      const lines = pane?.render(width) ?? [];

      return [
        ...lines,
        ...(lines.length > 0 ? [""] : []),
        `${margin}${labelledRule(theme, width - pad, label, token)}`,
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
