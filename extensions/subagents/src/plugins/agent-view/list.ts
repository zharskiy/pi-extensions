import type { KeyPress, OverlayApi, ThemeToken } from "../../../../../core/adapter/contract.ts";
import { renderRow, rowLayout } from "../../components/agent-row.ts";
import { errorText, innerWidth, PAD, truncatePainted } from "../../components/format.ts";
import { tickFor } from "../../components/refresh.ts";
import { carrySelection, type TreeRow } from "../../components/tree.ts";
import { type AgentRecord, isClosed } from "../../model/types.ts";
import {
  clearTargets,
  listedTerminals,
  listHint,
  listSections,
  subtitle,
  visibleRecords,
} from "./list-model.ts";
import type { ListComponent } from "./overlay.ts";

type ListDeps = {
  records(): AgentRecord[];
  lingerMs: number;
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

export const createAgentList = (deps: ListDeps, api: OverlayApi): ListComponent => {
  const scroll = api.createScroll();
  let visible: AgentRecord[] = [];
  let sections: ReturnType<typeof listSections> = [];
  let rows: TreeRow[] = [];
  let ids: string[] = [];
  let subtitleText = "";
  let selectedId: string | undefined;
  let feedback: Feedback | undefined;
  let feedbackTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingStopAll = false;
  let unwatch: (() => void) | undefined;
  let disposed = false;

  const compute = () => {
    const previousIds = ids;

    visible = visibleRecords(deps.records(), Date.now(), deps.lingerMs, deps.cleared);
    sections = listSections(visible);
    subtitleText = subtitle(visible);
    rows = sections.flatMap((section) => section.rows);
    ids = rows.map((row) => row.record.id);
    selectedId = carrySelection(previousIds, ids, selectedId) ?? ids[0];
  };

  const reload = () => {
    if (disposed) {
      return;
    }

    compute();
    api.requestRender();
  };

  const tickMs = () => tickFor(visible, true);

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

    showFeedback(`stop failed: ${errorText(error)}`, "warning", STOP_FAILED_MS);
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

  const bodyLines = (width: number, inner: number) => {
    const theme = api.theme;

    if (rows.length === 0) {
      return {
        lines: [PAD + theme.fg("muted", theme.truncate("No agents running", inner))],
        selectedLine: -1,
      };
    }

    const now = Date.now();
    const layout = rowLayout(rows, now, width, selectedId !== undefined, theme);
    const lines: string[] = [];
    let selectedLine = -1;

    sections.forEach((section, index) => {
      if (index > 0) {
        lines.push("");
      }

      lines.push(PAD + theme.bold(theme.truncate(section.title, inner)));

      section.rows.forEach((row) => {
        const isSelected = row.record.id === selectedId;

        if (isSelected) {
          selectedLine = lines.length;
        }

        lines.push(renderRow({ ...row, selected: isSelected }, now, width, theme, layout));
      });
    });

    return { lines, selectedLine };
  };

  const footerLines = (inner: number) => {
    const theme = api.theme;
    const hint = PAD + theme.fg("dim", theme.truncate(listHint(selected()), inner));

    return feedback ? [PAD + theme.fg(feedback.token, theme.truncate(feedback.text, inner)), hint] : [hint];
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
    const stoppable = listedTerminals(visible).filter(
      (record) => record.state === "queued" || record.state === "running",
    );

    if (!pendingStopAll) {
      if (stoppable.length === 0) {
        showFeedback("No running agents", "muted", NO_AGENTS_MS);
        return;
      }

      pendingStopAll = true;
      showFeedback("Press X again to stop all agents", "warning", STOP_ALL_CONFIRM_MS);
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
