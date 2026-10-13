import type { KeyPress, OverlayApi, ThemeToken } from "../../../../../core/adapter/contract.ts";
import { nameColumn, renderRow } from "../../components/agent-row.ts";
import { innerWidth, PAD, truncateCols, truncatePainted } from "../../components/format.ts";
import type { TreeRow } from "../../components/tree.ts";
import { type AgentRecord, isClosed } from "../../model/types.ts";
import {
  carrySelection,
  clearTargets,
  type ListSection,
  listedTerminals,
  listHint,
  listSections,
  subtitle,
  visibleRecords,
} from "./list-model.ts";
import type { ListComponent } from "./overlay.ts";

export type ListDeps = {
  records(): AgentRecord[];
  lingerMs: number;
  cleared: Set<string>;
  stop(id: string): Promise<unknown> | undefined;
  watch(tickMs: () => number | undefined, onChange: () => void): () => void;
  open(id: string): void;
  leave(): void;
  selected?: string;
};

export const STOP_ALL_CONFIRM_MS = 3_000;

export const NO_AGENTS_MS = 2_000;

const STOP_FAILED_MS = 3_000;

type Feedback = { text: string; token: ThemeToken };

export const createAgentList = (deps: ListDeps, api: OverlayApi): ListComponent => {
  const scroll = api.createScroll();
  let visible: AgentRecord[] = [];
  let sections: ListSection[] = [];
  let rows: TreeRow[] = [];
  let ids: string[] = [];
  let selectedId: string | undefined = deps.selected;
  let feedback: Feedback | undefined;
  let feedbackTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingStopAll = false;
  let unwatch: (() => void) | undefined;
  let disposed = false;

  const compute = () => {
    const previousIds = ids;

    visible = visibleRecords(deps.records(), Date.now(), deps.lingerMs, deps.cleared);
    sections = listSections(visible);
    rows = sections.flatMap((section) => section.rows);
    ids = rows.map((row) => row.record.id);
    selectedId = carrySelection(previousIds, ids, selectedId) ?? ids[0];

    if (selectedId !== undefined && !ids.includes(selectedId)) {
      selectedId = ids[0];
    }
  };

  const reload = () => {
    if (disposed) {
      return;
    }

    compute();
    api.requestRender();
  };

  const tickMs = () => {
    if (visible.some((record) => record.state === "running" || record.state === "grace")) {
      return 100;
    }

    return ids.length > 0 ? 1_000 : undefined;
  };

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

    showFeedback(`stop failed: ${(error as Error).message}`, "warning", STOP_FAILED_MS);
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
        [
          ["Agents", (text) => theme.bold(text)],
          [subtitle(visible), (text) => theme.fg("dim", text)],
        ],
        inner,
      )
    );
  };

  const bodyLines = (width: number, inner: number) => {
    const theme = api.theme;

    if (rows.length === 0) {
      return { lines: [PAD + theme.fg("muted", truncateCols("No agents running", inner))], selectedLine: -1 };
    }

    const now = Date.now();
    const nameCols = nameColumn(rows);
    const lines: string[] = [];
    let selectedLine = -1;

    sections.forEach((section, index) => {
      if (index > 0) {
        lines.push("");
      }

      lines.push(PAD + theme.bold(truncateCols(section.title, inner)));

      section.rows.forEach((row) => {
        const isSelected = row.record.id === selectedId;

        if (isSelected) {
          selectedLine = lines.length;
        }

        lines.push(renderRow({ ...row, selected: isSelected }, now, width, theme, nameCols));
      });
    });

    return { lines, selectedLine };
  };

  const footerLines = (inner: number) => {
    const theme = api.theme;
    const hint = PAD + theme.fg("dim", truncateCols(listHint(selected()), inner));

    return feedback ? [PAD + theme.fg(feedback.token, truncateCols(feedback.text, inner)), hint] : [hint];
  };

  const bodyHeight = (footerLength: number) => Math.max(1, api.rows() - 5 - footerLength);

  const render = (width: number) => {
    const inner = innerWidth(width);
    const footer = footerLines(inner);
    const height = bodyHeight(footer.length);
    const body = bodyLines(width, inner);
    let window = scroll.window(body.lines, height);
    const top = scroll.state().top;
    const line = body.selectedLine;

    if (line >= 0 && (line < top || line >= top + height)) {
      scroll.scrollTo(line < top ? Math.max(0, line - 1) : line - height + 1);
      window = scroll.window(body.lines, height);
    }

    const padding = Array.from({ length: height - window.length }, () => "");

    return ["", titleLine(inner), "", ...window, ...padding, "", ...footer, ""];
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
    const open = listedTerminals(visible).filter((record) => !isClosed(record.state));

    if (!pendingStopAll) {
      if (open.length === 0) {
        showFeedback("No running agents", "muted", NO_AGENTS_MS);
        return;
      }

      pendingStopAll = true;
      showFeedback("Press X again to stop all agents", "warning", STOP_ALL_CONFIRM_MS);
      return;
    }

    const stoppable = open.filter((record) => record.state === "queued" || record.state === "running");

    if (stoppable.length === 0) {
      return;
    }

    clearFeedback();
    run(stoppable.map((record) => deps.stop(record.id)));
  };

  const page = () => Math.max(1, bodyHeight(feedback ? 2 : 1) - 1);

  const actions: Partial<Record<KeyPress["name"], () => void>> = {
    up: () => move(-1),
    down: () => move(1),
    pageUp: () => move(-page()),
    pageDown: () => move(page()),
    home: () => select(0),
    end: () => select(ids.length - 1),
    enter: () => {
      if (selectedId !== undefined) {
        deps.open(selectedId);
      }
    },
    escape: () => deps.leave(),
  };

  const handleKey = (key: KeyPress) => {
    if (key.char === "X") {
      stopAll();
      return;
    }

    if (pendingStopAll) {
      clearFeedback();
    }

    if (key.char === "x") {
      stopSelected();
      return;
    }

    actions[key.name]?.();
  };

  const dispose = () => {
    disposed = true;
    clearTimeout(feedbackTimer);
    feedbackTimer = undefined;
    unwatch?.();
    unwatch = undefined;
  };

  const suspend = () => {
    unwatch?.();
    unwatch = undefined;
  };

  const resume = () => {
    if (disposed) {
      return;
    }

    reload();
    unwatch?.();
    unwatch = deps.watch(tickMs, reload);
  };

  compute();

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
