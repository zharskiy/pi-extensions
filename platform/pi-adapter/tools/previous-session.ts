import { existsSync } from "node:fs";
import { homedir } from "node:os";
import type { EntryRenderer, ExtensionContext, SessionManager, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Container, Spacer, type TUI } from "@earendil-works/pi-tui";
import { readSessionBranch } from "../runtime/session-file.ts";
import type { ThemeToken } from "../types/theme.ts";
import type { AnyToolSpec } from "../types/tools.ts";
import { themeLike } from "../ui/theme-bridge.ts";
import { paddedComponent } from "./entry-renderers.ts";
import { sharedPad } from "./row-component.ts";
import { createTranscriptPane } from "./transcript.ts";

export const PREVIOUS_SESSION_TYPE = "pi-adapter:previous-session";

const MAX_SESSIONS = 5;

type PreviousSession = { file: string; leafId: string | null };

type Block = { component: Component; setExpanded(expanded: boolean): void };

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

export const previousSessionRenderer = (deps: RendererDeps): EntryRenderer => {
  const cache = new Map<string, Block>();
  const tui = { requestRender: () => deps.requestRender() } as unknown as TUI;

  const line = (theme: Theme, token: ThemeToken, text: string) =>
    paddedComponent(sharedPad, () => [themeLike(theme).fg(token, text)]);

  const noteBlock = (component: Component): Block => ({ component, setExpanded: () => {} });

  const sessionBlock = (previous: PreviousSession, theme: Theme, seen: string[]): Block => {
    const path = shownPath(previous.file);

    if (seen.includes(previous.file) || seen.length >= MAX_SESSIONS) {
      return noteBlock(line(theme, "dim", `» earlier sessions not shown · ${path}`));
    }

    const branch = readBranch(previous);

    if (!branch) {
      return noteBlock(line(theme, "warning", `» previous session not found · ${path}`));
    }

    const earlier = branch.customEntries
      .filter((entry) => entry.customType === PREVIOUS_SESSION_TYPE)
      .map((entry) => entry.data)
      .find(isPreviousSession);

    const nested = earlier ? sessionBlock(earlier, theme, [...seen, previous.file]) : undefined;
    const pane = createTranscriptPane(tui, deps.cwd(), { tools: deps.tools() });
    const container = new Container();

    pane.sync(branch.items);

    if (nested) {
      container.addChild(nested.component);
      container.addChild(new Spacer(1));
    }

    container.addChild(line(theme, "dim", `» previous session · ${path}`));
    container.addChild({ render: (width) => pane.render(width), invalidate: () => {} });

    return {
      component: container,
      setExpanded: (expanded) => {
        nested?.setExpanded(expanded);
        pane.setToolsExpanded(expanded);
      },
    };
  };

  return (entry, options, theme) => {
    const previous = entry.data;

    if (!isPreviousSession(previous)) {
      return undefined;
    }

    const key = `${previous.file}\n${previous.leafId}`;
    const block = cache.get(key) ?? sessionBlock(previous, theme, []);

    if (existsSync(previous.file)) {
      cache.set(key, block);
    }

    block.setExpanded(options.expanded);

    return block.component;
  };
};
