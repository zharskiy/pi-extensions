import type {
  InputPane,
  KeyPress,
  OverlayApi,
  SessionRecord,
  ThemeLike,
  ViewComponent,
} from "../../../../../core/adapter/contract.ts";
import {
  attentionText,
  chainLabel,
  finishSummary,
  progressText,
  stateIcon,
  truncate,
} from "../../components/agent-row.ts";
import {
  type CollapsibleSection,
  renderSections,
  setAllCollapsed,
  toggleSection,
} from "../../components/collapsible.ts";
import { contextBreakdown, renderBreakdown } from "../../components/context-breakdown.ts";
import { scrollHint, stopHint } from "../../components/hints.ts";
import { promptSections } from "../../components/system-prompt-block.ts";
import { effectiveContextLimit } from "../../model/context-limit.ts";
import { type AgentRecord, isClosed, type RouteResult, worktreeText } from "../../model/types.ts";
import type { ModeStore, ViewMode } from "./mode-store.ts";

export type ViewData = { record: AgentRecord; openedId?: string; session?: SessionRecord; error?: string };

type ContextSettings = {
  softRatio: number;
  reserveTokens: number;
  estimate(text: string): number;
};

type ViewDeps = {
  load(): ViewData;
  context?: ContextSettings;
  stop(): Promise<unknown> | undefined;
  send(text: string): Promise<RouteResult>;
  subscribe(onChange: () => void): () => void;
  modes?: ModeStore;
  now?: () => number;
};

const wrapPlain = (text: string, width: number) => {
  const size = Math.max(10, width);

  if (text.length <= size) {
    return [text];
  }

  return Array.from({ length: Math.ceil(text.length / size) }, (_, index) =>
    text.slice(index * size, (index + 1) * size),
  );
};

const INPUT_PLACEHOLDER = "message the agent…";

const inputHintText = (api: OverlayApi) =>
  [
    "Message box: Enter send",
    "Esc clear, again leaves the box",
    "Tab prompt sections",
    `${api.toolsKey} tool detail`,
    scrollHint(api.wheelScrolling),
  ].join(" · ");

const CONTEXT_KEY = "c";

const MODE_KEY = "v";

const modeHint = (mode: ViewMode) =>
  mode === "focus" ? `focus view, ${MODE_KEY} verbose` : `verbose view, ${MODE_KEY} focus`;

type HintOptions = {
  openedId?: string;
  breakdown: "unavailable" | "shown" | "hidden";
  mode: ViewMode;
};

const breakdownHint: Record<HintOptions["breakdown"], string | undefined> = {
  unavailable: undefined,
  shown: `${CONTEXT_KEY} hide context`,
  hidden: `${CONTEXT_KEY} context breakdown`,
};

const hintText = (api: OverlayApi, record: AgentRecord, options: HintOptions) => {
  const closed = isClosed(record.state);
  const { openedId, breakdown, mode } = options;

  return [
    "Esc close",
    openedId ? `opened ${openedId}, following the chain` : undefined,
    stopHint(record),
    `${api.toolsKey} tool detail`,
    scrollHint(api.wheelScrolling),
    breakdownHint[breakdown],
    closed ? "Tab/Enter prompt sections" : "Tab/Enter prompt sections, Tab to the message box",
    modeHint(mode),
    closed ? "agent closed, messages disabled" : undefined,
  ]
    .filter((part) => part !== undefined)
    .join(" · ");
};

const titleText = (record: AgentRecord, theme: ThemeLike, frame: number) => {
  const links = [
    record.predecessorId ? `continues ${record.predecessorId}` : undefined,
    record.successorId ? `continued by ${record.successorId}` : undefined,
  ]
    .filter((part) => part !== undefined)
    .map((part) => ` · ${part}`)
    .join("");

  const attention = attentionText(record);
  const alert = attention ? theme.fg("warning", ` · ${attention}`) : "";
  const name = theme.bold(`${record.id}${chainLabel(record)}`);

  return `${stateIcon(record.state, frame)} ${name} (${record.agent}) · ${record.state} · ${record.model ?? "model n/a"}${links}${alert}`;
};

type Status = { tone: "warning" | "dim"; text: string };

type ContextCache = {
  session?: SessionRecord;
  record: AgentRecord;
  version: number;
  width: number;
  theme: ThemeLike;
  lines: string[];
};

const promptKeyOf = (data: ViewData) => (data.session ? JSON.stringify(data.session.prompt) : "");

const deliveryText: Record<"steer" | "followUp" | "held", string> = {
  steer: "sent: steered into the current run",
  followUp: "sent: the agent answers in a new turn",
  held: "sent: held until the agent starts",
};

const mergeCollapsed = (previous: CollapsibleSection[], next: CollapsibleSection[]) => {
  const collapsedByTitle = new Map(previous.map((section) => [section.title, section.collapsed]));

  return next.map((section) => ({
    ...section,
    collapsed: collapsedByTitle.get(section.title) ?? section.collapsed,
  }));
};

type PromptBlock = {
  sections: CollapsibleSection[];
  focused: number;
  width: number;
  theme: ThemeLike;
  error?: string;
  lines: string[];
  headerRows: number[];
};

const transcriptKeyOf = (data: ViewData) => `${data.record.id}\n${data.record.sessionFile ?? ""}`;

export const createAgentView = (deps: ViewDeps, api: OverlayApi): ViewComponent => {
  const now = deps.now ?? Date.now;
  let transcript = api.createTranscript();
  const scroll = api.createScroll();
  let mode: ViewMode = deps.modes?.read() ?? "focus";
  let data = deps.load();
  let promptKey = promptKeyOf(data);
  let transcriptKey = transcriptKeyOf(data);
  let sections = data.session ? promptSections(data.session.prompt) : [];
  let frame = 0;
  let closed = false;
  let toolsExpanded = false;
  let focused = 0;
  let inputFocused = false;
  let input: InputPane | undefined;
  let status: Status | undefined;
  let headerRows: number[] = [];
  let promptCache: PromptBlock | undefined;
  let contextShown = false;
  let contextCache: ContextCache | undefined;

  const applyMode = () => {
    const verbose = mode === "verbose";

    sections = setAllCollapsed(sections, !verbose);
    toolsExpanded = verbose;
    contextShown = verbose;

    transcript.setToolsExpanded(verbose);
  };

  const toggleMode = () => {
    mode = mode === "focus" ? "verbose" : "focus";

    applyMode();
    deps.modes?.write(mode);
  };

  const syncTranscript = () => {
    const key = transcriptKeyOf(data);

    if (key !== transcriptKey) {
      transcriptKey = key;
      transcript = api.createTranscript();
      transcript.setToolsExpanded(toolsExpanded);
    }

    transcript.sync(data.session?.items ?? []);
  };

  applyMode();
  syncTranscript();

  const messageBox = () => {
    if (isClosed(data.record.state)) {
      return undefined;
    }

    if (!input) {
      input = api.createInput(INPUT_PLACEHOLDER);
      input.setFocused(inputFocused);
    }

    return input;
  };

  const setInputFocus = (value: boolean) => {
    inputFocused = value;
    input?.setFocused(value);
  };

  const reload = () => {
    if (closed) {
      return;
    }

    const previous = data.session;

    data = deps.load();
    frame += 1;

    const key = data.session === previous ? promptKey : promptKeyOf(data);

    if (key !== promptKey) {
      const fresh = data.session ? promptSections(data.session.prompt) : [];

      promptKey = key;
      sections = mergeCollapsed(sections, setAllCollapsed(fresh, mode === "focus"));
    }

    if (isClosed(data.record.state)) {
      setInputFocus(false);
    }

    syncTranscript();
    api.requestRender();
  };

  const unsubscribe = deps.subscribe(reload);

  const headerLines = (width: number) => {
    const record = data.record;
    const theme = api.theme;
    const detail = isClosed(record.state) ? finishSummary(record, now()) : progressText(record, now());

    const worktree = record.worktree
      ? [theme.fg("muted", truncate(`worktree: ${worktreeText(record.worktree)}`, width))]
      : [];

    return [
      titleText(record, theme, frame),
      theme.fg("muted", truncate(`Task: ${record.description}`, width)),
      ...worktree,
      theme.fg("dim", truncate(detail, width)),
      theme.fg("dim", "─".repeat(Math.max(0, width))),
    ];
  };

  const contextLines = (settings: ContextSettings, width: number) => {
    const theme = api.theme;
    const cached = contextCache;

    const record = data.record;

    const reusable =
      cached !== undefined &&
      cached.session === data.session &&
      cached.record === record &&
      cached.version === record.version &&
      cached.width === width &&
      cached.theme === theme;

    if (reusable) {
      return cached.lines;
    }

    const window = record.context?.window ?? 0;
    const prompt = data.session?.prompt ?? { sections: [], tools: [], skills: [], guidelines: [] };

    const breakdown = contextBreakdown({
      prompt,
      items: data.session?.items ?? [],
      measured: record.context?.tokens ?? data.session?.contextTokens,
      limit: effectiveContextLimit(record.contextLimit, window, settings.reserveTokens),
      window,
      softRatio: settings.softRatio,
      estimate: settings.estimate,
    });

    const lines = renderBreakdown(breakdown, theme, width, `${CONTEXT_KEY} hides`).concat(
      theme.fg("dim", "─".repeat(Math.max(0, width))),
    );

    contextCache = { session: data.session, record, version: record.version, width, theme, lines };

    return lines;
  };

  const contextBlock = (width: number) =>
    contextShown && deps.context ? contextLines(deps.context, width) : [];

  const promptBlock = (width: number) => {
    const theme = api.theme;
    const cached = promptCache;
    const sectionFocus = inputFocused ? -1 : focused;

    const reusable =
      cached?.sections === sections &&
      cached.focused === sectionFocus &&
      cached.width === width &&
      cached.theme === theme &&
      cached.error === data.error;

    if (reusable) {
      return cached;
    }

    const rendered = renderSections(sections, sectionFocus, theme, (text) => wrapPlain(text, width - 4));

    rendered.lines.unshift(theme.bold("Effective prompt"));

    if (data.error) {
      rendered.lines.push(theme.fg("warning", data.error));
    }

    rendered.lines.push("", theme.bold("Transcript"));

    promptCache = {
      sections,
      focused: sectionFocus,
      width,
      theme,
      error: data.error,
      lines: rendered.lines,
      headerRows: rendered.headerRows.map((row) => row + 1),
    };

    return promptCache;
  };

  const bodyLines = (width: number) => {
    const prompt = promptBlock(width);
    const transcriptLines = transcript.render(width);

    headerRows = prompt.headerRows;

    if (transcriptLines.length === 0) {
      return prompt.lines.concat(api.theme.fg("dim", "(no transcript yet)"));
    }

    return prompt.lines.concat(transcriptLines);
  };

  const positionText = () => {
    const position = scroll.state();
    const last = Math.min(position.total, position.top + position.height);
    const follow = position.following ? " · following" : "";

    return `${position.top + 1}-${last}/${position.total}${follow}`;
  };

  const messageLines = (width: number) => {
    const theme = api.theme;
    const box = messageBox();
    const lines: string[] = [];

    if (box) {
      const marker = inputFocused ? theme.fg("accent", "›") : " ";
      const line = box.render(width - 2)[0] ?? "";

      lines.push(`${marker} ${inputFocused ? line : theme.fg("dim", line)}`);
    }

    if (status) {
      lines.push(theme.fg(status.tone, truncate(status.text, width)));
    }

    return lines;
  };

  const hintLine = () => {
    const breakdown = deps.context ? (contextShown ? "shown" : "hidden") : "unavailable";

    const hint = inputFocused
      ? inputHintText(api)
      : hintText(api, data.record, { openedId: data.openedId, breakdown, mode });

    return `${api.theme.fg("dim", hint)}  ${api.theme.fg("dim", positionText())}`;
  };

  const render = (width: number) => {
    const header = headerLines(width).concat(contextBlock(width));
    const message = messageLines(width);
    const height = Math.max(3, api.rows() - header.length - message.length - 1);

    const window = scroll.window(bodyLines(width), height);
    const padding = Array.from({ length: height - window.length }, () => "");

    return header.concat(window, padding, message, hintLine());
  };

  const focusSection = (index: number) => {
    if (sections.length === 0) {
      return;
    }

    focused = (index + sections.length) % sections.length;

    const row = headerRows[focused] ?? 0;
    const position = scroll.state();

    if (row < position.top || row >= position.top + position.height) {
      scroll.scrollTo(row);
    }
  };

  const cycleFocus = () => {
    if (inputFocused) {
      setInputFocus(false);
      focusSection(0);
      return;
    }

    const lastSection = focused >= sections.length - 1;

    if (lastSection && messageBox()) {
      setInputFocus(true);
      return;
    }

    focusSection(focused + 1);
  };

  const dispose = () => {
    closed = true;
    unsubscribe();
  };

  const close = () => {
    dispose();
    api.close();
  };

  const fail = (error: unknown) => {
    if (closed) {
      return;
    }

    status = { tone: "warning", text: `stop failed: ${(error as Error).message}` };
    api.requestRender();
  };

  const stop = () => {
    if (!isClosed(data.record.state)) {
      void Promise.resolve(deps.stop()).then(reload).catch(fail);
    }
  };

  const toggleTools = () => {
    toolsExpanded = !toolsExpanded;
    transcript.setToolsExpanded(toolsExpanded);
  };

  const showRouteResult = (result: RouteResult, text: string, box: InputPane) => {
    if (result.ok) {
      status = { tone: "dim", text: deliveryText[result.delivery] };
    }

    if (!result.ok) {
      status = { tone: "warning", text: result.error };
    }

    if (!result.ok && box.value() === "") {
      box.setValue(text);
    }

    reload();
  };

  const submit = (box: InputPane) => {
    const text = box.value().trim();

    if (text.length === 0) {
      return;
    }

    box.setValue("");

    void deps
      .send(text)
      .catch((error: unknown): RouteResult => ({ ok: false, error: (error as Error).message }))
      .then((result) => showRouteResult(result, text, box));
  };

  const escapeInput = (box: InputPane) => {
    if (box.value() !== "") {
      box.setValue("");
      return;
    }

    setInputFocus(false);
  };

  const page = () => Math.max(1, scroll.state().height - 1);

  const scrollActions: Partial<Record<KeyPress["name"], () => void>> = {
    toggleTools,
    pageUp: () => scroll.scrollBy(-page()),
    pageDown: () => scroll.scrollBy(page()),
    home: () => scroll.scrollToStart(),
    end: () => scroll.scrollToEnd(),
  };

  const actions: Partial<Record<KeyPress["name"], () => void>> = {
    ...scrollActions,
    escape: close,
    enter: () => {
      sections = toggleSection(sections, focused);
    },
    space: () => {
      sections = toggleSection(sections, focused);
    },
    tab: cycleFocus,
    up: () => scroll.scrollBy(-1),
    down: () => scroll.scrollBy(1),
  };

  const handleInputKey = (key: KeyPress, box: InputPane) => {
    const scrollAction = scrollActions[key.name];

    if (scrollAction) {
      scrollAction();
      return;
    }

    if (key.name === "escape") {
      escapeInput(box);
      return;
    }

    if (key.name === "tab") {
      cycleFocus();
      return;
    }

    if (box.feed(key) === "submitted") {
      submit(box);
    }
  };

  const handleKey = (key: KeyPress) => {
    const box = messageBox();

    status = undefined;

    if (inputFocused && box) {
      handleInputKey(key, box);
      return;
    }

    if (key.char === "x") {
      stop();
      return;
    }

    if (key.char === CONTEXT_KEY && deps.context) {
      contextShown = !contextShown;
      return;
    }

    if (key.char === MODE_KEY) {
      toggleMode();
      return;
    }

    actions[key.name]?.();
  };

  return {
    render,
    handleKey,
    handleWheel: (lines) => {
      scroll.scrollBy(lines);
    },
    dispose,
  };
};
