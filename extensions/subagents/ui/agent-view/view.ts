import {
  type ClipboardUi,
  type KeyPress,
  type OverlayApi,
  PAD,
  type ThemeLike,
  type ThemeToken,
  type ViewComponent,
} from "../../../../platform/pi-adapter/index.ts";
import { DOT, errorText } from "../../../../platform/shared/index.ts";
import { countLine, type KeyHint, keyHints, preview, wrapChild } from "../../../../platform/ui-kit/index.ts";
import type { ViewData } from "../../core/agent-view/source.ts";
import { agentReceipt, formatCtx, type ReceiptSegment, singleLine } from "../../core/components/receipt.ts";
import { tickFor } from "../../core/components/refresh.ts";
import { type AgentRecord, isClosed, type Worktree } from "../../core/model/agent-record.ts";
import { effectiveContextLimit } from "../../core/model/context-limit.ts";
import { agentName } from "../components/agent-row.ts";
import { alignRight, innerWidth, padLine, receiptText, truncatePainted } from "../components/format.ts";
import { stateGlyph, stateToken, stopWords } from "../components/state-text.ts";
import { requestLineCount, requestLines, requestText } from "./request-block.ts";

type ViewDeps = {
  load(): ViewData;
  back: boolean;
  reserveTokens: number;
  stop(): Promise<unknown> | undefined;
  watch(tickMs: () => number | undefined, onChange: () => void, onTick: () => void): () => void;
  leave(): void;
  clipboard: ClipboardUi;
};

const RELOAD_TICK_MS = 1_000;

const GAP = "  ";

const CHROME_ROWS = 5;

const ctxPercent = (data: ViewData, reserveTokens: number) => {
  const { record } = data;
  const tokens = record.context?.tokens ?? data.session?.contextTokens;
  const limit = effectiveContextLimit(record.contextLimit, record.context?.window ?? 0, reserveTokens);

  return tokens === null || tokens === undefined || limit <= 0 ? undefined : (tokens / limit) * 100;
};

const titleLine = (record: AgentRecord, theme: ThemeLike, inner: number, now: number) =>
  PAD +
  truncatePainted(
    theme,
    [
      [stateGlyph(record.state, now), (text) => theme.fg(stateToken(record.state), text)],
      [" ", (text) => text],
      [agentName(record), (text) => theme.bold(text)],
      [`${GAP}${singleLine(record.description)}`, (text) => theme.fg("muted", text)],
    ],
    inner,
  );

const receiptLine = (data: ViewData, theme: ThemeLike, inner: number, now: number, reserveTokens: number) => {
  const context = formatCtx(ctxPercent(data, reserveTokens));
  const segments: ReceiptSegment[] = [
    ...agentReceipt({ ...data.record, activity: undefined }, now, { live: true }),
    ...(context ? [{ kind: "activity" as const, text: context, token: "muted" as const }] : []),
  ];

  return PAD + theme.truncate(receiptText(segments, inner, theme), inner);
};

const chainName = (record: AgentRecord, index: number) =>
  agentName({ agent: record.agent, chainIndex: index + 1 });

const worktreeLine = (worktree: Worktree) => {
  if (worktree.cleanup === "removed") {
    return "Worktree removed";
  }

  if (worktree.cleanup === "branch kept") {
    return `Worktree removed${DOT}branch ${worktree.branch} kept`;
  }

  const kept = worktree.cleanup === "kept" ? `${DOT}kept` : "";

  return `Worktree ${worktree.path}${DOT}branch ${worktree.branch}${kept}`;
};

const ERROR_ROWS = 6;

const errorLines = (record: AgentRecord, theme: ThemeLike, inner: number) => {
  if (record.state !== "failed") {
    return [];
  }

  const groups = (record.error ?? "unknown error")
    .trim()
    .split("\n")
    .map((line) => wrapChild(line, inner, 0, theme));
  const { shown } = preview(groups.flat(), { keep: "head", max: ERROR_ROWS });
  const starts = groups.map((_, index) =>
    groups.slice(0, index).reduce((total, rows) => total + rows.length, 0),
  );
  const hidden = starts.filter((start) => start >= ERROR_ROWS).length;
  const more = hidden > 0 ? [PAD + countLine({ hidden, end: "more", noun: "line" }, inner, theme)] : [];

  return [...shown.map((line) => PAD + theme.fg("error", line)), ...more];
};

const handoffLines = (record: AgentRecord, theme: ThemeLike, inner: number) => {
  if (record.state !== "handoff") {
    return [];
  }

  const invalid = record.error ? ` (invalid: ${record.error})` : "";

  return [padLine(theme, "warning", `handoff file ${record.handoffPath}${invalid}`, inner)];
};

export const headerLines = (
  data: ViewData,
  theme: ThemeLike,
  width: number,
  now: number,
  reserveTokens: number,
): string[] => {
  const { record, chain } = data;
  const inner = innerWidth(width);
  const dim = (text: string) => padLine(theme, "dim", text, inner);
  const names = chain.map((_, index) => chainName(record, index));
  const chainText = `Chain ${names.join(" → ")} (${chain.length} sessions)${DOT}viewing ${agentName(record)}`;

  return [
    titleLine(record, theme, inner, now),
    receiptLine(data, theme, inner, now, reserveTokens),
    dim(`${record.model ?? "model n/a"}${DOT}id ${record.id}`),
    ...errorLines(record, theme, inner),
    ...(chain.length > 1 ? [dim(chainText)] : []),
    ...handoffLines(record, theme, inner),
    ...(record.worktree ? [dim(worktreeLine(record.worktree))] : []),
    theme.fg("dim", "─".repeat(Math.max(0, width))),
  ];
};

const transcriptKeyOf = (data: ViewData) => `${data.record.id}\n${data.record.sessionFile ?? ""}`;

export const createAgentView = (deps: ViewDeps, api: OverlayApi): ViewComponent => {
  const scroll = api.createScroll();
  let loadedAt = Date.now();
  let data = deps.load();
  let transcript = api.createTranscript();
  let transcriptKey = transcriptKeyOf(data);
  let toolsExpanded = false;
  let requestExpanded = false;
  let pendingTop = false;
  let notice: { text: string; token: ThemeToken } | undefined;
  let lastHeight = 1;
  let layout = { width: 0, headerRows: 0, requestRows: 0, bodyRows: 0 };
  let disposed = false;

  const payload = () => data.session?.providerPayload;

  const hasRequest = () => data.error === undefined && requestLineCount(payload()) > 0;

  const isOpen = () => !isClosed(data.record.state);

  const syncTranscript = () => {
    const key = transcriptKeyOf(data);

    if (key !== transcriptKey) {
      transcriptKey = key;
      requestExpanded = false;
      transcript = api.createTranscript();
      transcript.setToolsExpanded(toolsExpanded);
    }

    transcript.sync(data.session?.items ?? []);
  };

  syncTranscript();

  const reload = () => {
    if (disposed) {
      return;
    }

    loadedAt = Date.now();
    data = deps.load();
    syncTranscript();
    api.requestRender();
  };

  const tick = () => (Date.now() - loadedAt >= RELOAD_TICK_MS ? reload() : api.requestRender());

  const unwatch = deps.watch(() => tickFor([data.record], false), reload, tick);

  const bodyLines = (width: number) => {
    const theme = api.theme;
    const inner = innerWidth(width);

    if (data.error !== undefined) {
      return {
        request: [],
        lines: [padLine(theme, "warning", data.error, inner)],
        clickable: 0,
      };
    }

    const request = [...requestLines(payload(), isOpen(), requestExpanded, width, theme), ""];
    const lines = transcript.render(width);

    if (lines.length === 0) {
      return { request, lines: [PAD + theme.fg("dim", "(no transcript yet)")], clickable: 0 };
    }

    return { request, lines, clickable: lines.length };
  };

  const hintTiers = (): KeyHint[][] => {
    const record = data.record;
    const exit: KeyHint = ["esc", deps.back ? "to go back" : "to close"];
    const stop: KeyHint[] = isOpen() ? [["x", stopWords(record.state)]] : [];
    const request: KeyHint[] = hasRequest()
      ? [["r", requestExpanded ? "to hide the request" : "to show the request"]]
      : [];
    const tools: KeyHint = [api.toolsKey, toolsExpanded ? "to collapse tools" : "to expand tools"];
    const copy: KeyHint[] = request.length ? [["c", "to copy request"]] : [];

    const lead = [exit, ...stop, ...request];

    return [[...lead, tools, ...copy], [...lead, tools], lead];
  };

  const positionText = () => {
    const { top, height, total, following } = scroll.state();

    if (total === 0) {
      return undefined;
    }

    const follow = isOpen() && !following ? " · end to follow" : "";

    return `${top + 1}-${Math.min(total, top + height)}/${total}${follow}`;
  };

  const hintLine = (inner: number) => {
    const theme = api.theme;
    const position = positionText();
    const right = position ? theme.fg("dim", position) : "";
    const tiers = hintTiers().map((pairs) => keyHints(pairs, theme));
    const placed = tiers
      .map((tier) =>
        right ? alignRight(theme, tier, right, inner) : theme.width(tier) <= inner ? tier : undefined,
      )
      .find((line) => line !== undefined);

    return PAD + (placed ?? theme.truncate(tiers.at(-1) ?? "", inner));
  };

  const render = (width: number) => {
    const theme = api.theme;
    const inner = innerWidth(width);
    const header = headerLines(data, theme, width, Date.now(), deps.reserveTokens);
    const footer = notice ? padLine(theme, notice.token, notice.text, inner) : "";
    const height = Math.max(3, api.rows() - header.length - CHROME_ROWS);
    const { request, lines, clickable } = bodyLines(width);
    const body = request.concat(lines);
    let window = scroll.window(body, height);

    if (pendingTop) {
      pendingTop = false;
      scroll.scrollToStart();
      window = scroll.window(body, height);
    }

    lastHeight = height;
    layout = {
      width,
      headerRows: header.length,
      requestRows: request.length,
      bodyRows: request.length + clickable,
    };

    const padding = Array.from({ length: height - window.length }, () => "");

    return ["", ...header, ...window, ...padding, "", footer, hintLine(inner), ""];
  };

  const show = (text: string, token: ThemeToken) => {
    if (disposed) {
      return;
    }

    notice = { text, token };
    api.requestRender();
  };

  const fail = (error: unknown) => show(`Stop failed: ${errorText(error)}`, "warning");

  const copyRequest = () => {
    if (!hasRequest()) {
      return;
    }

    void deps.clipboard.copyText(requestText(payload())).then(
      () => show("Copied the request", "success"),
      (error) => show(`Copy failed: ${errorText(error)}`, "warning"),
    );
  };

  const toggleRequest = () => {
    if (!hasRequest()) {
      return;
    }

    requestExpanded = !requestExpanded;

    if (requestExpanded) {
      pendingTop = true;
      scroll.scrollToStart();
    } else {
      pendingTop = false;
      scroll.scrollToEnd();
    }

    api.requestRender();
  };

  const stop = () => {
    if (isOpen()) {
      void Promise.resolve(deps.stop()).then(reload).catch(fail);
    }
  };

  const toggleTools = () => {
    toolsExpanded = !toolsExpanded;
    transcript.setToolsExpanded(toolsExpanded);
  };

  const handleClick = (x: number, y: number) => {
    const row = y - 1 - layout.headerRows;

    if (row < 0 || row >= lastHeight) {
      return false;
    }

    const { top } = scroll.state();
    const index = top + row;

    if (index < layout.requestRows) {
      const toggles = index === 0 && hasRequest();

      if (toggles) {
        toggleRequest();
      }

      return toggles;
    }

    if (index >= layout.bodyRows || !transcript.click(index - layout.requestRows, x, layout.width)) {
      return false;
    }

    scroll.scrollTo(top, { disableFollow: true });
    api.requestRender();

    return true;
  };

  const page = () => Math.max(1, lastHeight - 1);

  const actions: Partial<Record<KeyPress["name"], () => void>> = {
    up: () => scroll.scrollBy(-1),
    down: () => scroll.scrollBy(1),
    pageUp: () => scroll.scrollBy(-page()),
    pageDown: () => scroll.scrollBy(page()),
    home: () => scroll.scrollToStart(),
    end: () => scroll.scrollToEnd(),
    toggleTools,
    escape: () => deps.leave(),
  };

  const chars: Record<string, () => void> = { r: toggleRequest, x: stop, c: copyRequest };

  const handleKey = (key: KeyPress) => {
    notice = undefined;

    const action = key.name === "other" && key.shortcut ? chars[key.shortcut] : actions[key.name];

    action?.();
  };

  const dispose = () => {
    if (disposed) {
      return;
    }

    disposed = true;
    unwatch();
  };

  return {
    render,
    handleKey,
    handleWheel: (lines) => {
      scroll.scrollBy(lines);
    },
    handleClick,
    dispose,
  };
};
