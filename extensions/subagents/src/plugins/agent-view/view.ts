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
import { type CollapsibleSection, renderSections, toggleSection } from "../../components/collapsible.ts";
import { promptSections } from "../../components/system-prompt-block.ts";
import { type AgentRecord, isClosed, type RouteResult } from "../../model/types.ts";

export type ViewData = { record: AgentRecord; openedId?: string; session?: SessionRecord; error?: string };

export type ViewDeps = {
  load(): ViewData;
  stop(): Promise<unknown> | undefined;
  send(text: string): Promise<RouteResult>;
  subscribe(onChange: () => void): () => void;
  now?: () => number;
};

export const wrapPlain = (text: string, width: number) => {
  const size = Math.max(10, width);

  if (text.length <= size) {
    return [text];
  }

  return Array.from({ length: Math.ceil(text.length / size) }, (_, index) =>
    text.slice(index * size, (index + 1) * size),
  );
};

export const INPUT_PLACEHOLDER = "message the agent…";

const stopHint = (record: AgentRecord) => {
  if (record.state === "grace") {
    return "x again closes now";
  }

  return isClosed(record.state) ? undefined : "x stop";
};

const scrollHint = (api: OverlayApi) =>
  api.wheelScrolling ? "PgUp/PgDn Home/End wheel scroll" : "PgUp/PgDn Home/End scroll";

export const inputHintText = (api: OverlayApi) =>
  [
    "Message box: Enter send",
    "Esc clear, again leaves the box",
    "Tab prompt sections",
    `${api.toolsKey} tool detail`,
    scrollHint(api),
  ].join(" · ");

export const hintText = (api: OverlayApi, record: AgentRecord, openedId?: string) => {
  const closed = isClosed(record.state);

  return [
    "Esc close",
    openedId ? `opened ${openedId}, following the chain` : undefined,
    stopHint(record),
    `${api.toolsKey} tool detail`,
    scrollHint(api),
    closed ? "Tab/Enter prompt sections" : "Tab/Enter prompt sections, Tab to the message box",
    closed ? "agent closed, messages disabled" : undefined,
  ]
    .filter((part) => part !== undefined)
    .join(" · ");
};

export const titleText = (record: AgentRecord, theme: ThemeLike) => {
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

  return `${stateIcon(record.state, 0)} ${name} (${record.agent}) · ${record.state} · ${record.model ?? "model n/a"}${links}${alert}`;
};

type Status = { tone: "warning" | "dim"; text: string };

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

export const createAgentView = (deps: ViewDeps, api: OverlayApi): ViewComponent => {
  const now = deps.now ?? Date.now;
  const transcript = api.createTranscript();
  const scroll = api.createScroll();
  let data = deps.load();
  let sections = data.session ? promptSections(data.session.prompt) : [];
  let toolsExpanded = api.toolsExpanded;
  let focused = 0;
  let inputFocused = false;
  let input: InputPane | undefined;
  let status: Status | undefined;
  let headerRows: number[] = [];
  let promptCache: PromptBlock | undefined;

  transcript.sync(data.session?.items ?? []);

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
    data = deps.load();
    sections = mergeCollapsed(sections, data.session ? promptSections(data.session.prompt) : []);

    if (isClosed(data.record.state)) {
      setInputFocus(false);
    }

    transcript.sync(data.session?.items ?? []);
    api.requestRender();
  };

  const unsubscribe = deps.subscribe(reload);

  const headerLines = (width: number) => {
    const record = data.record;
    const theme = api.theme;
    const detail = isClosed(record.state) ? finishSummary(record, now()) : progressText(record, now());

    return [
      titleText(record, theme),
      theme.fg("muted", truncate(`Task: ${record.description}`, width)),
      theme.fg("dim", truncate(detail, width)),
      theme.fg("dim", "─".repeat(Math.max(0, width))),
    ];
  };

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
    const hint = inputFocused ? inputHintText(api) : hintText(api, data.record, data.openedId);

    return `${api.theme.fg("dim", hint)}  ${api.theme.fg("dim", positionText())}`;
  };

  const render = (width: number) => {
    const header = headerLines(width);
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

  const close = () => {
    unsubscribe();
    api.close();
  };

  const stop = () => {
    if (!isClosed(data.record.state)) {
      void Promise.resolve(deps.stop()).then(reload);
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

    actions[key.name]?.();
  };

  return {
    render,
    handleKey,
    handleWheel: (lines) => {
      scroll.scrollBy(lines);
    },
    dispose: unsubscribe,
  };
};
