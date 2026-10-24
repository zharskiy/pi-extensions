import { keyHints } from "../../../../../core/manager/hints.ts";
import type { KeyPress, OverlayApi, ThemeToken } from "../../../../../pi-adapter/index.ts";
import { type RowLayout, renderRow, rowLayout } from "../../components/agent-row.ts";
import { errorText, innerWidth, PAD, padLine, truncatePainted } from "../../components/format.ts";
import { tickFor } from "../../components/refresh.ts";
import { carrySelection, stoppableAgents, type TreeRow } from "../../components/tree.ts";
import { type AgentRecord, isClosed } from "../../model/types.ts";
import { clearTargets, listHint, listSections, subtitle, visibleRecords } from "./list-model.ts";
import type { ListComponent } from "./overlay.ts";

type ListDeps = {
  records(): AgentRecord[];
  cleared: Set<string>;
  stop(id: string): Promise<unknown> | undefined;
  watch(tickMs: () => number | undefined, onChange: () => void): () => void;
  open(record: AgentRecord): void;
  leave(): void;
};

const STOP_ALL_CONFIRM_MS = 3_000;

const NO_AGENTS_MS = 2_000;

const STOP_FAILED_MS = 3_000;

type Feedback = { text: string; token: ThemeToken };

type Slot = { kind: "gap" } | { kind: "title"; title: string } | { kind: "row"; row: TreeRow };

const GAP: Slot = { kind: "gap" };

const slotsOf = (sections: ReturnType<typeof listSections>): Slot[] =>
  sections.flatMap((section, index): Slot[] => [
    ...(index > 0 ? [GAP] : []),
    { kind: "title", title: section.title },
    ...section.rows.map((row): Slot => ({ kind: "row", row })),
  ]);

export const createAgentList = (deps: ListDeps, api: OverlayApi): ListComponent => {
  const scroll = api.createScroll();
  let visible: AgentRecord[] = [];
  let rows: TreeRow[] = [];
  let ids: string[] = [];
  let slots: Slot[] = [];
  let placeholders: string[] = [""];
  let lineOf = new Map<string, number>();
  let subtitleText = "";
  let selectedId: string | undefined;
  let feedback: Feedback | undefined;
  let feedbackTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingStopAll = false;
  let unwatch: (() => void) | undefined;
  let disposed = false;

  const compute = () => {
    const previousIds = ids;

    visible = visibleRecords(deps.records(), deps.cleared);
    const sections = listSections(visible);
    subtitleText = subtitle(visible);
    rows = sections.flatMap((section) => section.rows);
    ids = rows.map((row) => row.record.id);
    slots = slotsOf(sections);
    placeholders = Array.from({ length: Math.max(1, slots.length) }, () => "");
    lineOf = new Map(
      slots.flatMap((slot, line) => (slot.kind === "row" ? [[slot.row.record.id, line]] : [])),
    );
    selectedId = carrySelection(previousIds, ids, selectedId) ?? ids[0];
  };

  const reload = () => {
    if (disposed) {
      return;
    }

    compute();
    api.requestRender();
  };

  const tickMs = () => tickFor(visible, false);

  const selected = () => rows.find((row) => row.record.id === selectedId)?.record;

  const clearFeedback = () => {
    clearTimeout(feedbackTimer);
    feedbackTimer = undefined;
    feedback = undefined;
    pendingStopAll = false;
  };

  const showFeedback = (text: string, token: ThemeToken, ms: number) => {
    clearTimeout(feedbackTimer);
    feedback = { text, token };
    feedbackTimer = setTimeout(() => {
      feedbackTimer = undefined;

      if (disposed) {
        return;
      }

      feedback = undefined;
      pendingStopAll = false;
      api.requestRender();
    }, ms);
    feedbackTimer.unref?.();
  };

  const fail = (error: unknown) => {
    if (disposed) {
      return;
    }

    showFeedback(`Stop failed: ${errorText(error)}`, "warning", STOP_FAILED_MS);
    api.requestRender();
  };

  const run = (stops: (Promise<unknown> | undefined)[]) => {
    void Promise.all(stops).then(reload).catch(fail);
  };

  const titleLine = (inner: number) => {
    const theme = api.theme;

    return (
      PAD +
      truncatePainted(
        theme,
        [
          ["Agents", (text) => theme.bold(text)],
          [subtitleText, (text) => theme.fg("dim", text)],
        ],
        inner,
      )
    );
  };

  const bodyLine = (index: number, inner: number, layout?: RowLayout) => {
    const theme = api.theme;
    const slot = slots[index];

    if (!slot || !layout) {
      return padLine(theme, "muted", "No running agents", inner);
    }

    if (slot.kind === "gap") {
      return "";
    }

    if (slot.kind === "title") {
      return PAD + theme.bold(theme.truncate(slot.title, inner));
    }

    return renderRow(
      { ...slot.row, selected: slot.row.record.id === selectedId },
      inner + PAD.length,
      theme,
      layout,
    );
  };

  const footerLines = (inner: number) => {
    const theme = api.theme;
    const hint = theme.truncate(PAD + keyHints(listHint(selected()), theme), inner + PAD.length);

    return feedback ? [padLine(theme, feedback.token, feedback.text, inner), hint] : [hint];
  };

  const bodyHeight = (footerLength: number) => Math.max(1, api.rows() - 5 - footerLength);

  const render = (width: number) => {
    const inner = innerWidth(width);
    const footer = footerLines(inner);
    const height = bodyHeight(footer.length);
    let window = scroll.window(placeholders, height);
    const top = scroll.state().top;
    const line = selectedId === undefined ? -1 : (lineOf.get(selectedId) ?? -1);

    if (line >= 0 && (line < top || line >= top + height)) {
      scroll.scrollTo(line < top ? Math.max(0, line - 1) : line - height + 1);
      window = scroll.window(placeholders, height);
    }

    const start = scroll.state().top;
    const now = Date.now();
    const layout = rows.length > 0 ? rowLayout(rows, now, inner + PAD.length, api.theme) : undefined;
    const body = window.map((_, offset) => bodyLine(start + offset, inner, layout));
    const padding = Array.from({ length: height - body.length }, () => "");

    return ["", titleLine(inner), "", ...body, ...padding, "", ...footer, ""];
  };

  const select = (index: number) => {
    if (ids.length === 0) {
      return;
    }

    selectedId = ids[Math.max(0, Math.min(ids.length - 1, index))];
  };

  const move = (delta: number) => {
    const index = selectedId === undefined ? -1 : ids.indexOf(selectedId);

    select(index < 0 ? 0 : index + delta);
  };

  const stopSelected = () => {
    const record = selected();

    if (!record) {
      return;
    }

    if (!isClosed(record.state)) {
      run([deps.stop(record.id)]);
      return;
    }

    clearTargets(record.id, visible).forEach((id) => {
      deps.cleared.add(id);
    });
    reload();
  };

  const stopAll = () => {
    const stoppable = stoppableAgents(visible);

    if (!pendingStopAll) {
      if (stoppable.length === 0) {
        showFeedback("No running agents", "muted", NO_AGENTS_MS);
        return;
      }

      pendingStopAll = true;
      showFeedback("Press shift+x again to stop all agents", "warning", STOP_ALL_CONFIRM_MS);
      return;
    }

    clearFeedback();
    run(stoppable.map((record) => deps.stop(record.id)));
  };

  const page = () => Math.max(1, bodyHeight(feedback ? 2 : 1) - 1);

  const names: Partial<Record<KeyPress["name"], () => void>> = {
    up: () => move(-1),
    down: () => move(1),
    pageUp: () => move(-page()),
    pageDown: () => move(page()),
    home: () => select(0),
    end: () => select(ids.length - 1),
    enter: () => {
      const record = selected();

      if (record) {
        deps.open(record);
      }
    },
    right: () => deps.leave(),
    escape: () => deps.leave(),
  };

  const chars: Record<string, () => void> = { x: stopSelected, X: stopAll };

  const handleKey = (key: KeyPress) => {
    const action = key.name === "other" && key.char ? chars[key.char] : names[key.name];

    if (pendingStopAll && action !== stopAll) {
      clearFeedback();
    }

    action?.();
  };

  const suspend = () => {
    unwatch?.();
    unwatch = undefined;
  };

  const dispose = () => {
    disposed = true;
    clearTimeout(feedbackTimer);
    feedbackTimer = undefined;
    suspend();
  };

  const resume = () => {
    if (disposed) {
      return;
    }

    reload();
    unwatch?.();
    unwatch = deps.watch(tickMs, reload);
  };

  return {
    render,
    handleKey,
    handleWheel: (lines) => {
      move(lines);
    },
    dispose,
    suspend,
    resume,
  };
};
