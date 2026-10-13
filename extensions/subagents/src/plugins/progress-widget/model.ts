import type { ThemeLike } from "../../../../../core/adapter/contract.ts";
import { treeRow } from "../../components/agent-row.ts";
import type { Settings } from "../../model/settings.ts";
import { type AgentRecord, isClosed } from "../../model/types.ts";

const lingerFor = (record: AgentRecord, settings: Pick<Settings, "lingerMs" | "failedLingerMs">) =>
  record.state === "done" ? settings.lingerMs : settings.failedLingerMs;

const isVisible = (
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

type CachedRow = { version: number; width: number; theme: ThemeLike; line: string };

export const createClosedRowCache = () => {
  const cache = new Map<string, CachedRow>();

  const row = (record: AgentRecord, now: number, frame: number, theme: ThemeLike, width: number) => {
    if (!isClosed(record.state)) {
      return treeRow(record, now, frame, theme, width);
    }

    const cached = cache.get(record.id);

    if (cached && cached.version === record.version && cached.width === width && cached.theme === theme) {
      return cached.line;
    }

    const line = treeRow(record, now, frame, theme, width);

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
  frame: number,
  theme: ThemeLike,
  width: number,
  row: typeof treeRow,
) => {
  const running = records.filter((record) => !isClosed(record.state)).length;
  const header = theme.fg("muted", `Agents · ${running} running · /agents to browse`);
  const lines = records.map((record) => row(record, now, frame, theme, width));

  lines.unshift(header);

  return lines;
};
