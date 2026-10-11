import type { ThemeLike } from "../../adapter/contract.ts";
import { treeRow } from "../../components/agent-row.ts";
import type { Settings } from "../../manager/settings.ts";
import { type AgentRecord, isClosed } from "../../manager/types.ts";

export const SPINNER_INTERVAL_MS = 120;

export const lingerFor = (record: AgentRecord, settings: Pick<Settings, "lingerMs" | "failedLingerMs">) =>
  record.state === "done" ? settings.lingerMs : settings.failedLingerMs;

export const isVisible = (
  record: AgentRecord,
  now: number,
  settings: Pick<Settings, "lingerMs" | "failedLingerMs">,
) => {
  if (!isClosed(record.state)) {
    return true;
  }

  const ended = record.endedAt ?? now;

  return now - ended < lingerFor(record, settings);
};

export const visibleRecords = (
  records: AgentRecord[],
  now: number,
  settings: Pick<Settings, "lingerMs" | "failedLingerMs">,
) => records.filter((record) => isVisible(record, now, settings));

export type WidgetRow = (
  record: AgentRecord,
  now: number,
  frame: number,
  theme: ThemeLike,
  width: number,
) => string;

export const widgetRow: WidgetRow = treeRow;

type CachedRow = { version: number; width: number; theme: ThemeLike; line: string };

export const createClosedRowCache = (): WidgetRow & { prune(records: AgentRecord[]): void } => {
  const cache = new Map<string, CachedRow>();

  const row = (record: AgentRecord, now: number, frame: number, theme: ThemeLike, width: number) => {
    if (!isClosed(record.state)) {
      return widgetRow(record, now, frame, theme, width);
    }

    const cached = cache.get(record.id);

    if (cached && cached.version === record.version && cached.width === width && cached.theme === theme) {
      return cached.line;
    }

    const line = widgetRow(record, now, frame, theme, width);

    cache.set(record.id, { version: record.version, width, theme, line });

    return line;
  };

  row.prune = (records: AgentRecord[]) => {
    const visibleIds = new Set(records.map((record) => record.id));

    cache.forEach((_, id) => {
      if (!visibleIds.has(id)) {
        cache.delete(id);
      }
    });
  };

  return row;
};

export const widgetLines = (
  records: AgentRecord[],
  now: number,
  theme: ThemeLike,
  width: number,
  row: WidgetRow = widgetRow,
) => {
  const frame = Math.floor(now / SPINNER_INTERVAL_MS);
  const running = records.filter((record) => !isClosed(record.state)).length;
  const header = theme.fg("muted", `Agents · ${running} running · /agents to browse`);
  const lines = records.map((record) => row(record, now, frame, theme, width));

  lines.unshift(header);

  return lines;
};

export type Throttle = { (): void; cancel(): void };

export const createThrottle = (run: () => void, intervalMs: () => number): Throttle => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let last = Number.NEGATIVE_INFINITY;

  const fire = () => {
    timer = undefined;
    last = Date.now();
    run();
  };

  const throttled = () => {
    if (timer) {
      return;
    }

    const wait = last + intervalMs() - Date.now();

    if (wait <= 0) {
      fire();
      return;
    }

    timer = setTimeout(fire, wait);
  };

  throttled.cancel = () => {
    if (timer) {
      clearTimeout(timer);
    }

    timer = undefined;
  };

  return throttled;
};
