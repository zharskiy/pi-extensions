import {
  type ExtensionAPI,
  type ExtensionContext,
  getLatestCompactionEntry,
  keyText,
  type SessionEntry,
  type SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { createLineageReader, LINEAGE_TYPE, type LineageEntry, lineageEntryOf } from "../runtime/lineage.ts";
import { linkKey } from "../runtime/lineage-walk.ts";
import type { ThemeLike, ThemeToken } from "../types/theme.ts";
import type { AnyToolSpec } from "../types/tools.ts";
import type { EntryRender, TranscriptItem } from "../types/view.ts";
import { labelledRule } from "../ui/rules.ts";
import { createTranscriptPane } from "./transcript.ts";

const DEFAULT_LABEL = "continued from previous session";

const COMPACTED_HERE = "compacted here";

const LINEAGE_LABELS = { handoff: "lineage: handoff", compaction: "lineage: compaction" } as const;

type Pane = ReturnType<typeof createTranscriptPane>;

type Part = { token: ThemeToken; label: string; pane?: Pane };

type Block = { parts: Part[]; count: number };

type RendererDeps = {
  branch(): readonly SessionEntry[];
  cwd(): string;
  tools(): AnyToolSpec[];
  requestRender(): void;
};

const UNCOUNTED: TranscriptItem["kind"][] = ["summary", "entry"];

const messageCount = (count: number) => `${count} earlier ${count === 1 ? "message" : "messages"}`;

const counted = (items: readonly TranscriptItem[]) =>
  items.filter((item) => !UNCOUNTED.includes(item.kind)).length;

export const showLineage = (ctx: ExtensionContext, label?: string) => {
  const file = ctx.sessionManager.getSessionFile();

  if (!file) {
    return undefined;
  }

  const lineage: LineageEntry = { file, leafId: ctx.sessionManager.getLeafId(), reason: "handoff", label };

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

const sameLink = (a: LineageEntry, b: LineageEntry) =>
  a.reason === b.reason && a.file === b.file && a.leafId === b.leafId;

export const lineageRenderer = (deps: RendererDeps) => {
  const readLineage = createLineageReader();
  const cache = new Map<string, Block>();
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

  const paneOf = (items: TranscriptItem[]) => {
    const pane = createTranscriptPane(tui, deps.cwd(), { tools: deps.tools(), theme: () => current });

    pane.sync(items);

    return pane;
  };

  const linkParts = (
    start: LineageEntry,
    link: LineageEntry,
    segments: TranscriptItem[][],
    total: number,
  ) => {
    const label =
      link === start && start.reason === "compaction"
        ? `${messageCount(total)}, compacted`
        : (link.label ?? DEFAULT_LABEL);

    return segments.map(
      (segment, index): Part => ({
        token: "dim",
        label: index === segments.length - 1 ? label : COMPACTED_HERE,
        pane: paneOf(segment),
      }),
    );
  };

  const buildBlock = (lineage: LineageEntry): Block => {
    const read = readLineage(lineage);
    const total = read.links.reduce(
      (sum, { read: linkRead }) =>
        sum +
        (linkRead.status === "read"
          ? linkRead.value.reduce((count, segment) => count + counted(segment), 0)
          : 0),
      0,
    );

    const parts = read.links.flatMap(({ link, read: linkRead }): Part[] => {
      if (linkRead.status === "missing") {
        return [{ token: "warning", label: "previous session not found" }];
      }

      if (linkRead.status === "failed") {
        return [{ token: "warning", label: "previous session not readable" }];
      }

      return linkParts(lineage, link, linkRead.value, total);
    });

    const truncated: Part[] = read.truncated ? [{ token: "dim", label: "earlier sessions not shown" }] : [];

    return { parts: [...truncated, ...parts], count: total };
  };

  const blockFor = (lineage: LineageEntry) => {
    const key = `${linkKey(lineage)}\n${lineage.reason}\n${lineage.label ?? ""}`;
    const cached = cache.get(key);

    if (cached) {
      return cached;
    }

    building = true;

    try {
      const block = buildBlock(lineage);

      cache.set(key, block);

      return block;
    } finally {
      building = false;
    }
  };

  const laterCompactionOnBranch = (lineage: LineageEntry) => {
    const lineages = deps
      .branch()
      .map((entry) => (entry.type === "custom" ? lineageEntryOf(entry.customType, entry.data) : undefined));
    const position = lineages.findLastIndex((entry) => entry !== undefined && sameLink(entry, lineage));

    return position >= 0 && lineages.slice(position + 1).some((entry) => entry?.reason === "compaction");
  };

  const drawParts = (parts: Part[], width: number, expanded: boolean, theme: ThemeLike, pad: number) => {
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

  const render: EntryRender = (data, width, expanded, theme, pad) => {
    const lineage = lineageEntryOf(LINEAGE_TYPE, data);

    if (!lineage) {
      return [];
    }

    if (lineage.reason === "compaction" && laterCompactionOnBranch(lineage)) {
      return [];
    }

    current = theme;

    const block = blockFor(lineage);

    if (lineage.reason === "handoff" || expanded) {
      return drawParts(block.parts, width, expanded, theme, pad);
    }

    const key = keyText("app.tools.expand");
    const hint = key ? ` (${key} to expand)` : "";

    return [
      `${" ".repeat(pad)}${labelledRule(theme, width - pad, `${messageCount(block.count)}, compacted${hint}`)}`,
    ];
  };

  const invalidate = () => {
    cache.forEach((block) => {
      block.parts.forEach(({ pane }) => {
        pane?.invalidate();
      });
    });
  };

  return { render, invalidate };
};
