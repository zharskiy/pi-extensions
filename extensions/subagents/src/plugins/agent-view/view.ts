import type {
  AnyToolSpec,
  KeyPress,
  OverlayApi,
  ThemeLike,
  ViewComponent,
} from "../../../../../core/adapter/contract.ts";
import {
  alignRight,
  displayWidth,
  elapsedOf,
  firstLine,
  formatCtx,
  formatDuration,
  formatTokens,
  formatToolUses,
  innerWidth,
  PAD,
  SEP,
  singleLine,
  truncateCols,
  truncatePainted,
} from "../../components/format.ts";
import { requestLineCount, requestLines } from "../../components/request-block.ts";
import { stateGlyph, stateToken, stateWord } from "../../components/state-text.ts";
import { effectiveContextLimit } from "../../model/context-limit.ts";
import { type AgentRecord, type AgentViewOrigin, isClosed, worktreeText } from "../../model/types.ts";
import type { ViewData } from "./loader.ts";

export type ViewDeps = {
  load(): ViewData;
  from: AgentViewOrigin;
  tools: AnyToolSpec[];
  reserveTokens: number;
  stop(): Promise<unknown> | undefined;
  watch(tickMs: () => number | undefined, onChange: () => void): () => void;
  leave(): void;
};

const MIN_DESCRIPTION = 8;

const ctxPercent = (data: ViewData, reserveTokens: number) => {
  const { record } = data;
  const tokens = record.context?.tokens ?? data.session?.contextTokens;
  const limit = effectiveContextLimit(record.contextLimit, record.context?.window ?? 0, reserveTokens);

  return tokens === null || tokens === undefined || limit <= 0 ? undefined : (tokens / limit) * 100;
};

const titleLine = (record: AgentRecord, theme: ThemeLike, inner: number, now: number) => {
  const glyph = stateGlyph(record.state, now);
  const name = record.chainIndex > 1 ? `${record.agent} #${record.chainIndex}` : record.agent;
  const prefix = `${glyph} ${name} › `;
  const description = singleLine(record.description);
  const room = inner - displayWidth(prefix);

  if (room < MIN_DESCRIPTION) {
    return (
      PAD +
      truncatePainted(
        [
          [glyph, (text) => theme.fg(stateToken(record.state), text)],
          [" ", (text) => text],
          [name, (text) => theme.bold(text)],
          [` › ${description}`, (text) => text],
        ],
        inner,
      )
    );
  }

  return `${PAD}${theme.fg(stateToken(record.state), glyph)} ${theme.bold(name)} › ${truncateCols(description, room)}`;
};

const statsText = (data: ViewData, now: number, reserveTokens: number) => {
  const { record } = data;

  return [
    formatToolUses(record.toolCalls),
    record.tokens > 0 ? `${formatTokens(record.tokens)} tokens` : undefined,
    formatDuration(elapsedOf(record, now)),
    formatCtx(ctxPercent(data, reserveTokens)),
  ]
    .filter((part) => part !== undefined)
    .join(SEP);
};

const outcomeLines = (record: AgentRecord, theme: ThemeLike, inner: number) => {
  if (record.state === "failed") {
    return [
      PAD + theme.fg("error", truncateCols(`error: ${firstLine(record.error ?? "unknown error")}`, inner)),
    ];
  }

  if (record.state === "handoff") {
    const invalid = record.error ? ` (invalid: ${record.error})` : "";

    return [PAD + theme.fg("warning", truncateCols(`handoff: ${record.handoffPath}${invalid}`, inner))];
  }

  return [];
};

export const headerLines = (
  data: ViewData,
  theme: ThemeLike,
  width: number,
  now: number,
  reserveTokens: number,
): string[] => {
  const { record, chain, openedId } = data;
  const inner = innerWidth(width);
  const dim = (text: string) => PAD + theme.fg("dim", truncateCols(text, inner));
  const opened = openedId ? ` · opened ${openedId}` : "";

  return [
    titleLine(record, theme, inner, now),
    dim(`${stateWord(record.state)} · ${record.model ?? "model n/a"} · id ${record.id}`),
    dim(statsText(data, now, reserveTokens)),
    ...outcomeLines(record, theme, inner),
    ...(chain.length > 1 ? [dim(`chain: ${chain.join(" → ")} (${chain.length} sessions)${opened}`)] : []),
    ...(record.worktree ? [dim(`worktree: ${worktreeText(record.worktree)}`)] : []),
    theme.fg("dim", "─".repeat(Math.max(0, width))),
  ];
};

const transcriptKeyOf = (data: ViewData) => `${data.record.id}\n${data.record.sessionFile ?? ""}`;

const tickOf = (record: AgentRecord) => {
  if (record.state === "running" || record.state === "grace") {
    return 100;
  }

  return record.state === "queued" ? 1_000 : undefined;
};

export const createAgentView = (deps: ViewDeps, api: OverlayApi): ViewComponent => {
  const scroll = api.createScroll();
  let transcript = api.createTranscript({ tools: deps.tools });
  let data = deps.load();
  let transcriptKey = transcriptKeyOf(data);
  let toolsExpanded = false;
  let requestExpanded = false;
  let pendingTop = false;
  let notice: string | undefined;
  let lastHeight = 1;
  let layout = { width: 0, headerRows: 0, requestRows: 0, bodyRows: 0 };
  let disposed = false;

  const payload = () => data.session?.prompt.providerPayload;

  const hasRequest = () => data.error === undefined && requestLineCount(payload()) > 0;

  const isOpen = () => !isClosed(data.record.state);

  const syncTranscript = () => {
    const key = transcriptKeyOf(data);

    if (key !== transcriptKey) {
      transcriptKey = key;
      requestExpanded = false;
      transcript = api.createTranscript({ tools: deps.tools });
      transcript.setToolsExpanded(toolsExpanded);
    }

    transcript.sync(data.session?.items ?? []);
  };

  syncTranscript();

  const reload = () => {
    if (disposed) {
      return;
    }

    data = deps.load();
    syncTranscript();
    api.requestRender();
  };

  const unwatch = deps.watch(() => tickOf(data.record), reload);

  const bodyLines = (width: number) => {
    const theme = api.theme;
    const inner = innerWidth(width);

    if (data.error !== undefined) {
      return {
        request: [],
        lines: [PAD + theme.fg("warning", truncateCols(data.error, inner))],
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

  const hintText = () => {
    const record = data.record;
    const stop = record.state === "grace" ? "x to close now" : isOpen() ? "x to stop" : undefined;
    const request = hasRequest() ? (requestExpanded ? "r hide request" : "r request") : undefined;

    return [
      deps.from === "list" ? "esc to go back" : "esc to close",
      stop,
      request,
      `${api.toolsKey} tool detail`,
    ]
      .filter((part) => part !== undefined)
      .join(SEP);
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
    const hint = hintText();
    const position = positionText();
    const text = (position && alignRight(hint, position, inner)) || truncateCols(hint, inner);

    return PAD + api.theme.fg("dim", text);
  };

  const render = (width: number) => {
    const theme = api.theme;
    const inner = innerWidth(width);
    const header = headerLines(data, theme, width, Date.now(), deps.reserveTokens);
    const footer = notice ? [PAD + theme.fg("warning", truncateCols(notice, inner))] : [];
    const height = Math.max(3, api.rows() - header.length - 3 - (footer.length + 1));
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

    return ["", ...header, ...window, ...padding, "", ...footer, hintLine(inner), ""];
  };

  const fail = (error: unknown) => {
    if (disposed) {
      return;
    }

    notice = `stop failed: ${(error as Error).message}`;
    api.requestRender();
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

  const chars: Record<string, () => void> = { r: toggleRequest, x: stop };

  const handleKey = (key: KeyPress) => {
    notice = undefined;

    const action = key.name === "other" && key.char ? chars[key.char] : actions[key.name];

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
