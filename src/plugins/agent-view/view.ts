import type {
  KeyPress,
  OverlayApi,
  SessionRecord,
  ThemeLike,
  ViewComponent,
} from "../../adapter/contract.ts";
import { finishSummary, progressText, stateIcon, truncate } from "../../components/agent-row.ts";
import { type CollapsibleSection, renderSections, toggleSection } from "../../components/collapsible.ts";
import { promptSections } from "../../components/system-prompt-block.ts";
import { type AgentRecord, isClosed } from "../../manager/types.ts";

export type ViewData = { record: AgentRecord; session?: SessionRecord; error?: string };

export type ViewDeps = {
  load(): ViewData;
  stop(): Promise<unknown> | undefined;
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

const stopHint = (record: AgentRecord) => {
  if (record.state === "grace") {
    return "x again closes now";
  }

  return isClosed(record.state) ? undefined : "x stop";
};

export const hintText = (api: OverlayApi, record: AgentRecord) => {
  const scrollKeys = api.wheelScrolling ? "PgUp/PgDn Home/End wheel" : "PgUp/PgDn Home/End";

  return [
    "Esc close",
    stopHint(record),
    `${api.toolsKey} tool detail`,
    `${scrollKeys} scroll`,
    "Tab/Enter prompt sections",
  ]
    .filter((part) => part !== undefined)
    .join(" · ");
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
  let headerRows: number[] = [];
  let promptCache: PromptBlock | undefined;

  transcript.sync(data.session?.items ?? []);

  const reload = () => {
    data = deps.load();
    sections = mergeCollapsed(sections, data.session ? promptSections(data.session.prompt) : []);

    transcript.sync(data.session?.items ?? []);
    api.requestRender();
  };

  const unsubscribe = deps.subscribe(reload);

  const headerLines = (width: number) => {
    const record = data.record;
    const theme = api.theme;
    const detail = isClosed(record.state) ? finishSummary(record, now()) : progressText(record, now());
    const title = `${stateIcon(record.state, 0)} ${theme.bold(record.id)} (${record.agent}) · ${record.state} · ${record.model ?? "model n/a"}`;

    return [
      title,
      theme.fg("muted", truncate(`Task: ${record.description}`, width)),
      theme.fg("dim", truncate(detail, width)),
      theme.fg("dim", "─".repeat(Math.max(0, width))),
    ];
  };

  const promptBlock = (width: number) => {
    const theme = api.theme;
    const cached = promptCache;

    const reusable =
      cached?.sections === sections &&
      cached.focused === focused &&
      cached.width === width &&
      cached.theme === theme &&
      cached.error === data.error;

    if (reusable) {
      return cached;
    }

    const rendered = renderSections(sections, focused, theme, (text) => wrapPlain(text, width - 4));

    rendered.lines.unshift(theme.bold("Effective prompt"));

    if (data.error) {
      rendered.lines.push(theme.fg("warning", data.error));
    }

    rendered.lines.push("", theme.bold("Transcript"));

    promptCache = {
      sections,
      focused,
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

  const render = (width: number) => {
    const header = headerLines(width);
    const height = Math.max(3, api.rows() - header.length - 1);

    const window = scroll.window(bodyLines(width), height);
    const padding = Array.from({ length: height - window.length }, () => "");
    const hint = hintText(api, data.record);

    return header.concat(
      window,
      padding,
      `${api.theme.fg("dim", hint)}  ${api.theme.fg("dim", positionText())}`,
    );
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

  const page = () => Math.max(1, scroll.state().height - 1);

  const actions: Partial<Record<KeyPress["name"], () => void>> = {
    escape: close,
    toggleTools,
    enter: () => {
      sections = toggleSection(sections, focused);
    },
    space: () => {
      sections = toggleSection(sections, focused);
    },
    tab: () => focusSection(focused + 1),
    up: () => scroll.scrollBy(-1),
    down: () => scroll.scrollBy(1),
    pageUp: () => scroll.scrollBy(-page()),
    pageDown: () => scroll.scrollBy(page()),
    home: () => scroll.scrollToStart(),
    end: () => scroll.scrollToEnd(),
  };

  const handleKey = (key: KeyPress) => {
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
