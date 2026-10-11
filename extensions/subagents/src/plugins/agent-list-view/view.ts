import type { InputPane, KeyPress, OverlayApi, ViewComponent } from "../../../../../core/adapter/contract.ts";
import {
  emptyListText,
  listEntries,
  moveSelection,
  renderList,
  resolveSelection,
  selectedRecord,
} from "../../components/agent-list.ts";
import { truncate } from "../../components/agent-row.ts";
import { type AgentRecord, isClosed } from "../../model/types.ts";

export const FRAME_MS = 120;

export type ListDeps = {
  records(): AgentRecord[];
  open(id: string): void;
  stop(id: string): Promise<unknown> | undefined;
  subscribe(onChange: () => void): () => void;
  now?: () => number;
};

const SCROLL_KEYS = "PgUp/PgDn Home/End scroll";

const stopHint = (record: AgentRecord | undefined) => {
  if (!record || isClosed(record.state)) {
    return undefined;
  }

  return record.state === "grace" ? "x again closes now" : "x stop";
};

export const createAgentListView = (deps: ListDeps, api: OverlayApi): ViewComponent => {
  const now = deps.now ?? Date.now;
  const scroll = api.createScroll();
  let records = deps.records();
  let selectedId: string | undefined;
  let filter = "";
  let filterInput: InputPane | undefined;
  let pendingStopAll = 0;
  let notice: string | undefined;
  let revealSelection = true;

  const reload = () => {
    records = deps.records();
    api.requestRender();
  };

  const unsubscribe = deps.subscribe(reload);

  const entries = () => listEntries(records, filter);

  const openRecords = () => records.filter((record) => !isClosed(record.state));

  const hintText = () => {
    if (pendingStopAll > 0) {
      return api.theme.fg(
        "warning",
        `Stop all ${pendingStopAll} open agents? y confirms · any other key cancels`,
      );
    }

    if (filterInput) {
      return api.theme.fg(
        "dim",
        `Filter: type a name, id or state · ↑/↓ select · Enter keep filter · Esc clear filter · ${SCROLL_KEYS}`,
      );
    }

    const parts = [
      "↑/↓ select",
      "Enter open",
      stopHint(selectedRecord(entries(), selectedId)),
      "X stop all",
      "/ filter",
      filter ? "Esc clear filter" : "Esc close",
      SCROLL_KEYS,
    ];

    return api.theme.fg("dim", parts.filter((part) => part !== undefined).join(" · "));
  };

  const footerLines = (width: number) => {
    const lines: string[] = [];

    if (filterInput) {
      lines.push(`${api.theme.fg("accent", "/")} ${filterInput.render(width - 2)[0] ?? ""}`);
    }

    if (!filterInput && filter) {
      lines.push(api.theme.fg("dim", truncate(`filter: ${filter}`, width)));
    }

    if (notice) {
      lines.push(api.theme.fg("warning", truncate(notice, width)));
    }

    lines.push(hintText());

    return lines;
  };

  const headerLines = (width: number) => {
    const open = openRecords().length;
    const summary = api.theme.fg("dim", ` · ${open} open · ${records.length} total`);

    return [`${api.theme.bold("Agents")}${summary}`, api.theme.fg("dim", "─".repeat(Math.max(0, width)))];
  };

  const bodyWindow = (width: number, height: number) => {
    const list = entries();

    if (list.length === 0) {
      return scroll.window([api.theme.fg("dim", emptyListText(records.length, filter))], height);
    }

    const frame = Math.floor(now() / FRAME_MS);
    const rendered = renderList(list, selectedId, now(), frame, api.theme, width);
    const window = scroll.window(rendered.lines, height);
    const row = rendered.selectedRow;

    if (!revealSelection || row === undefined) {
      return window;
    }

    revealSelection = false;

    const top = scroll.state().top;

    if (row >= top && row < top + height) {
      return window;
    }

    scroll.scrollTo(row < top ? Math.max(0, row - 1) : row - height + 1);

    return scroll.window(rendered.lines, height);
  };

  const render = (width: number) => {
    const header = headerLines(width);
    const footer = footerLines(width);
    const height = Math.max(3, api.rows() - header.length - footer.length);

    const window = bodyWindow(width, height);
    const padding = Array.from({ length: height - window.length }, () => "");

    return header.concat(window, padding, footer);
  };

  const close = () => {
    unsubscribe();
    api.close();
  };

  const move = (delta: number) => {
    selectedId = moveSelection(entries(), selectedId, delta);
    revealSelection = true;
  };

  const openSelected = () => {
    const id = resolveSelection(entries(), selectedId);

    if (id === undefined) {
      return;
    }

    close();
    deps.open(id);
  };

  const stopSelected = () => {
    const record = selectedRecord(entries(), selectedId);

    if (!record || isClosed(record.state)) {
      return;
    }

    selectedId = record.id;

    void Promise.resolve(deps.stop(record.id)).then(reload);
  };

  const askStopAll = () => {
    const count = openRecords().length;

    if (count === 0) {
      notice = "no open agents to stop";
      return;
    }

    pendingStopAll = count;
  };

  const stopAll = () => {
    const stops = openRecords().map((record) => deps.stop(record.id));

    void Promise.all(stops).then(reload);
  };

  const clearFilter = () => {
    filter = "";
    filterInput = undefined;
    revealSelection = true;
  };

  const startFilter = () => {
    filterInput = api.createInput("filter by name, id or state");
    filterInput.setValue(filter);
  };

  const page = () => Math.max(1, scroll.state().height - 1);

  const scrollActions: Partial<Record<KeyPress["name"], () => void>> = {
    up: () => move(-1),
    down: () => move(1),
    pageUp: () => scroll.scrollBy(-page()),
    pageDown: () => scroll.scrollBy(page()),
    home: () => scroll.scrollToStart(),
    end: () => scroll.scrollToEnd(),
  };

  const charActions: Record<string, () => void> = {
    x: stopSelected,
    X: askStopAll,
    "/": startFilter,
  };

  const closeOrClearFilter = () => {
    if (filter) {
      clearFilter();
      return;
    }

    close();
  };

  const listActions: Partial<Record<KeyPress["name"], () => void>> = {
    ...scrollActions,
    enter: openSelected,
    escape: closeOrClearFilter,
  };

  const handleFilterKey = (key: KeyPress, input: InputPane) => {
    const scrollAction = scrollActions[key.name];

    if (scrollAction) {
      scrollAction();
      return;
    }

    if (key.name === "escape") {
      clearFilter();
      return;
    }

    if (key.name === "enter") {
      filterInput = undefined;
      return;
    }

    input.feed(key);
    filter = input.value();
    revealSelection = true;
  };

  const handleKey = (key: KeyPress) => {
    notice = undefined;

    if (pendingStopAll > 0) {
      pendingStopAll = 0;

      if (key.char === "y") {
        stopAll();
      }

      return;
    }

    if (filterInput) {
      handleFilterKey(key, filterInput);
      return;
    }

    const charAction = key.char === undefined ? undefined : charActions[key.char];

    if (charAction) {
      charAction();
      return;
    }

    listActions[key.name]?.();
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
