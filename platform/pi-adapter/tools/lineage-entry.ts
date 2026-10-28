import { existsSync } from "node:fs";
import { homedir } from "node:os";
import {
  type EntryRenderer,
  type ExtensionAPI,
  type ExtensionContext,
  getLatestCompactionEntry,
  keyText,
  type SessionEntry,
  type SessionManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { type Component, Container, Spacer, type TUI } from "@earendil-works/pi-tui";
import {
  createLineageReader,
  LINEAGE_TYPE,
  type LineageEntry,
  type LineageLinkRead,
  lineageEntryOf,
} from "../runtime/lineage.ts";
import { linkKey } from "../runtime/lineage-walk.ts";
import type { ThemeToken } from "../types/theme.ts";
import type { AnyToolSpec } from "../types/tools.ts";
import { themeLike } from "../ui/theme-bridge.ts";
import { paddedComponent } from "./entry-renderers.ts";
import { sharedPad } from "./row-component.ts";
import { createTranscriptPane } from "./transcript.ts";

const LINEAGE_LABELS = { handoff: "lineage: handoff", compaction: "lineage: compaction" } as const;

type Block = { component: Component; setExpanded(expanded: boolean): void };

type RendererDeps = {
  branch(): readonly SessionEntry[];
  cwd(): string;
  tools(): AnyToolSpec[];
  requestRender(): void;
};

const shownPath = (file: string) => {
  const home = homedir();

  return file.startsWith(`${home}/`) ? `~${file.slice(home.length)}` : file;
};

const messageCount = (count: number) => `${count} earlier ${count === 1 ? "message" : "messages"}`;

export const showLineage = (ctx: ExtensionContext) => {
  const file = ctx.sessionManager.getSessionFile();

  if (!file) {
    return undefined;
  }

  const lineage: LineageEntry = { file, leafId: ctx.sessionManager.getLeafId(), reason: "handoff" };

  return async (sessionManager: SessionManager) => {
    const id = sessionManager.appendCustomEntry(LINEAGE_TYPE, lineage);

    sessionManager.appendLabelChange(id, LINEAGE_LABELS.handoff);
  };
};

export const recordCompaction = (pi: ExtensionAPI, ctx: ExtensionContext) => {
  const sessionManager = ctx.sessionManager;
  const file = sessionManager.getSessionFile();
  const compaction = getLatestCompactionEntry(sessionManager.getBranch());
  const firstKept = compaction ? sessionManager.getEntry(compaction.firstKeptEntryId) : undefined;
  const leafId = firstKept?.parentId ?? null;

  if (!file || leafId === null) {
    return;
  }

  const recorded = sessionManager.getBranch().some((entry) => {
    const lineage = entry.type === "custom" ? lineageEntryOf(entry.customType, entry.data) : undefined;

    return lineage?.reason === "compaction" && lineage.file === file && lineage.leafId === leafId;
  });

  if (recorded) {
    return;
  }

  const lineage: LineageEntry = { file, leafId, reason: "compaction" };

  pi.appendEntry(LINEAGE_TYPE, lineage);

  const id = sessionManager.getLeafId();

  if (id) {
    pi.setLabel(id, LINEAGE_LABELS.compaction);
  }
};

export const lineageRenderer = (deps: RendererDeps): EntryRenderer => {
  const readLineage = createLineageReader();
  const cache = new Map<string, Block>();
  const tui = { requestRender: () => deps.requestRender() } as unknown as TUI;

  const line = (theme: Theme, token: ThemeToken, text: string) =>
    paddedComponent(sharedPad, () => [themeLike(theme).fg(token, text)]);

  const linkBlock = (theme: Theme, start: LineageEntry) => (view: LineageLinkRead) => {
    const path = shownPath(view.link.file);

    if (view.read.status === "missing") {
      return { component: line(theme, "warning", `» previous session not found · ${path}`) };
    }

    if (view.read.status === "failed") {
      return {
        component: line(theme, "warning", `» previous session not readable · ${path} · ${view.read.error}`),
      };
    }

    const compacted = view.link === start && start.reason === "compaction";
    const heading = compacted
      ? `» ${messageCount(view.read.value.length)}, compacted`
      : `» previous session · ${path}`;
    const pane = createTranscriptPane(tui, deps.cwd(), { tools: deps.tools() });
    const container = new Container();

    pane.sync(view.read.value);
    container.addChild(line(theme, "dim", heading));
    container.addChild({ render: (width) => pane.render(width), invalidate: () => {} });

    return { component: container, pane, count: view.read.value.length };
  };

  const lineageBlock = (lineage: LineageEntry, theme: Theme): Block => {
    const read = readLineage(lineage);
    const blocks = read.links.map(linkBlock(theme, lineage));
    const full = new Container();

    if (read.truncated) {
      full.addChild(line(theme, "dim", "» earlier sessions not shown"));
      full.addChild(new Spacer(1));
    }

    blocks.forEach((block, index) => {
      if (index > 0) {
        full.addChild(new Spacer(1));
      }

      full.addChild(block.component);
    });

    const setToolsExpanded = (expanded: boolean) => {
      blocks.forEach((block) => {
        block.pane?.setToolsExpanded(expanded);
      });
    };

    if (lineage.reason === "handoff") {
      return { component: full, setExpanded: setToolsExpanded };
    }

    const count = blocks.reduce((sum, block) => sum + (block.count ?? 0), 0);
    const key = keyText("app.tools.expand");
    const hint = key ? ` (${key} to expand)` : "";
    const collapsed = line(theme, "dim", `» ${messageCount(count)}, compacted${hint}`);
    let expanded = false;

    return {
      component: {
        render: (width) => (expanded ? full.render(width) : collapsed.render(width)),
        invalidate: () => {},
      },
      setExpanded: (next) => {
        expanded = next;
        setToolsExpanded(next);
      },
    };
  };

  const laterCompactionOnBranch = (entryId: string, lineage: LineageEntry) => {
    const branch = deps.branch();
    const position = branch.findIndex((item) => item.id === entryId);

    return (
      position >= 0 &&
      branch.slice(position + 1).some((later) => {
        const next = later.type === "custom" ? lineageEntryOf(later.customType, later.data) : undefined;

        return next?.reason === "compaction" && next.file === lineage.file;
      })
    );
  };

  return (entry, options, theme) => {
    const lineage = lineageEntryOf(entry.customType, entry.data);

    if (!lineage) {
      return undefined;
    }

    if (lineage.reason === "compaction" && laterCompactionOnBranch(entry.id, lineage)) {
      return undefined;
    }

    const key = `${linkKey(lineage)}\n${lineage.reason}`;
    const block = cache.get(key) ?? lineageBlock(lineage, theme);

    if (existsSync(lineage.file)) {
      cache.set(key, block);
    }

    block.setExpanded(options.expanded);

    return block.component;
  };
};
