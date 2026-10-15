import type { ContextBreakdown, ContextPart, RequestUsage } from "../../../core/adapter/contract.ts";
import { cacheHitPercent, reportedCache } from "../../../core/manager/cache.ts";

export type Snapshot = {
  breakdown: ContextBreakdown;
  lastRequest: RequestUsage | undefined;
  session: RequestUsage;
  timestamp: number;
  expandedByDefault: boolean;
};

export type CategoryKey =
  | "systemPrompt"
  | "systemTools"
  | "mcpTools"
  | "extensionTools"
  | "memoryFiles"
  | "skills"
  | "messages"
  | "free"
  | "reserve";

export type Category = { key: CategoryKey; label: string; tokens: number; percent: number };

export type CacheFigures = { lastTurn: number | undefined; lastMissed: boolean; session: number };

export type UsageModel = {
  model: string | undefined;
  window: number;
  used: number;
  estimated: boolean;
  percent: number;
  categories: Category[];
  full: boolean;
  overflow: number;
  cache: CacheFigures | undefined;
};

const LABELS: Record<CategoryKey, string> = {
  systemPrompt: "System prompt",
  systemTools: "System tools",
  mcpTools: "MCP tools",
  extensionTools: "Extension tools",
  memoryFiles: "Memory files",
  skills: "Skills",
  messages: "Messages",
  free: "Free space",
  reserve: "Compaction reserve",
};

export const USED_KEYS: readonly CategoryKey[] = [
  "systemPrompt",
  "systemTools",
  "mcpTools",
  "extensionTools",
  "memoryFiles",
  "skills",
  "messages",
];

export const sumParts = (parts: readonly ContextPart[]) => parts.reduce((sum, part) => sum + part.tokens, 0);

export const estimatedMessages = (messages: ContextBreakdown["messages"]) =>
  messages.user +
  messages.assistant +
  messages.thinking +
  messages.toolCalls +
  messages.toolResults +
  messages.other;

const fixedTokens = (
  breakdown: ContextBreakdown,
): Record<Exclude<CategoryKey, "messages" | "free" | "reserve">, number> => ({
  systemPrompt: breakdown.systemPrompt,
  systemTools: sumParts(breakdown.tools.builtin),
  mcpTools: sumParts(breakdown.tools.mcp),
  extensionTools: sumParts(breakdown.tools.extension),
  memoryFiles: sumParts(breakdown.memoryFiles),
  skills: sumParts(breakdown.skills),
});

export const cacheFigures = (
  lastRequest: RequestUsage | undefined,
  session: RequestUsage,
): CacheFigures | undefined => {
  const sessionHit = reportedCache(session) ? cacheHitPercent(session) : undefined;

  if (sessionHit === undefined) {
    return undefined;
  }

  const lastMissed = lastRequest !== undefined && !reportedCache(lastRequest);

  return {
    lastTurn: lastRequest ? (cacheHitPercent(lastRequest) ?? 0) : undefined,
    lastMissed,
    session: sessionHit,
  };
};

const percentOf = (tokens: number, window: number) => (window > 0 ? (tokens / window) * 100 : 0);

export const usageModel = (snapshot: Snapshot): UsageModel => {
  const { breakdown } = snapshot;
  const fixed = fixedTokens(breakdown);
  const fixedSum = Object.values(fixed).reduce((sum, tokens) => sum + tokens, 0);
  const estimated = breakdown.total === null;
  const messages = estimated
    ? estimatedMessages(breakdown.messages)
    : Math.max(0, (breakdown.total ?? 0) - fixedSum);
  const used = estimated ? fixedSum + messages : (breakdown.total ?? 0);
  const free = Math.max(0, breakdown.window - used - breakdown.reserve);
  const tokens: Record<CategoryKey, number> = { ...fixed, messages, free, reserve: breakdown.reserve };
  const full = used > breakdown.window - breakdown.reserve;

  const categories = (Object.keys(LABELS) as CategoryKey[])
    .filter((key) => tokens[key] > 0 || (key === "free" && full))
    .map((key) => ({
      key,
      label: LABELS[key],
      tokens: tokens[key],
      percent: percentOf(tokens[key], breakdown.window),
    }));

  return {
    model: breakdown.model,
    window: breakdown.window,
    used,
    estimated,
    percent: percentOf(used, breakdown.window),
    categories,
    full,
    overflow: Math.max(0, used - breakdown.window),
    cache: cacheFigures(snapshot.lastRequest, snapshot.session),
  };
};

export type Cell = { key: CategoryKey; partial: boolean };

export const gridCells = (model: UsageModel, count: number): Cell[] => {
  const cellTokens = model.window / count;

  if (cellTokens <= 0) {
    return Array.from({ length: count }, () => ({ key: "free" as const, partial: false }));
  }

  const reserveTokens = model.categories.find((category) => category.key === "reserve")?.tokens ?? 0;
  const reserveCells = Math.min(count, Math.round(reserveTokens / cellTokens));
  const room = count - reserveCells;

  const used = model.categories
    .filter((category) => USED_KEYS.includes(category.key))
    .flatMap((category) => {
      const exact = category.tokens / cellTokens;
      const whole = Math.floor(exact);
      const cells = Array.from({ length: whole }, () => ({ key: category.key, partial: false }));

      return exact > whole ? [...cells, { key: category.key, partial: true }] : cells;
    })
    .slice(0, room);

  const free = Array.from({ length: room - used.length }, () => ({ key: "free" as const, partial: false }));
  const reserve = Array.from({ length: reserveCells }, () => ({ key: "reserve" as const, partial: false }));

  return [...used, ...free, ...reserve];
};

export const shortPath = (path: string, home: string, cwd: string) => {
  if (cwd && path.startsWith(`${cwd}/`)) {
    return `./${path.slice(cwd.length + 1)}`;
  }

  if (home && (path === home || path.startsWith(`${home}/`))) {
    return `~${path.slice(home.length)}`;
  }

  return path;
};

export const byTokens = (parts: readonly ContextPart[]) =>
  [...parts].sort((left, right) => right.tokens - left.tokens || left.name.localeCompare(right.name));

const isPart = (value: unknown): value is ContextPart =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as ContextPart).name === "string" &&
  typeof (value as ContextPart).tokens === "number";

const isParts = (value: unknown): value is ContextPart[] => Array.isArray(value) && value.every(isPart);

const isUsage = (value: unknown): value is RequestUsage =>
  typeof value === "object" &&
  value !== null &&
  ["input", "cacheRead", "cacheWrite", "output"].every(
    (key) => typeof (value as Record<string, unknown>)[key] === "number",
  );

const isBreakdown = (value: unknown): value is ContextBreakdown => {
  const breakdown = value as ContextBreakdown | undefined;

  return (
    typeof breakdown === "object" &&
    breakdown !== null &&
    typeof breakdown.window === "number" &&
    typeof breakdown.reserve === "number" &&
    typeof breakdown.systemPrompt === "number" &&
    isParts(breakdown.memoryFiles) &&
    isParts(breakdown.skills) &&
    isParts(breakdown.tools?.builtin) &&
    isParts(breakdown.tools?.mcp) &&
    isParts(breakdown.tools?.extension) &&
    typeof breakdown.messages === "object" &&
    breakdown.messages !== null
  );
};

export const parseSnapshot = (data: unknown): Snapshot | undefined => {
  const snapshot = data as Snapshot | undefined;

  if (typeof snapshot !== "object" || snapshot === null || !isBreakdown(snapshot.breakdown)) {
    return undefined;
  }

  if (!isUsage(snapshot.session)) {
    return undefined;
  }

  return {
    breakdown: snapshot.breakdown,
    lastRequest: isUsage(snapshot.lastRequest) ? snapshot.lastRequest : undefined,
    session: snapshot.session,
    timestamp: typeof snapshot.timestamp === "number" ? snapshot.timestamp : 0,
    expandedByDefault: snapshot.expandedByDefault === true,
  };
};
