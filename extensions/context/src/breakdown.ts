import type { PromptTokens } from "../../../pi-adapter/index.ts";
import { cacheHitPercent, reportedCache, sessionCacheHit } from "../../../shared/index.ts";
import { type Breakdown, MESSAGE_KEYS, sumParts } from "./buckets.ts";
import type { Snapshot } from "./snapshot.ts";

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

export type Category = { key: CategoryKey; tokens: number; percent: number };

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

type FixedKey = Exclude<CategoryKey, "messages" | "free" | "reserve">;

const CATEGORY_KEYS: readonly CategoryKey[] = [
  "systemPrompt",
  "systemTools",
  "mcpTools",
  "extensionTools",
  "memoryFiles",
  "skills",
  "messages",
  "free",
  "reserve",
];

export const apportion = (weights: readonly number[], total: number) => {
  const sum = weights.reduce((acc, weight) => acc + weight, 0);

  if (sum <= 0 || total <= 0) {
    return weights.map(() => 0);
  }

  const quotas = weights.map((weight) => (weight * total) / sum);
  const floors = quotas.map(Math.floor);
  const left = total - floors.reduce((acc, value) => acc + value, 0);
  const extra = new Set(
    quotas
      .map((quota, index) => ({ index, rest: quota - Math.floor(quota) }))
      .sort((a, b) => b.rest - a.rest || a.index - b.index)
      .slice(0, left)
      .map((entry) => entry.index),
  );

  return floors.map((value, index) => (extra.has(index) ? value + 1 : value));
};

const fitTo = (fixed: Record<FixedKey, number>, total: number): Record<FixedKey, number> => {
  const keys = Object.keys(fixed) as FixedKey[];
  const shares = apportion(
    keys.map((key) => fixed[key]),
    total,
  );

  return Object.fromEntries(keys.map((key, index) => [key, shares[index] ?? 0])) as Record<FixedKey, number>;
};

const fixedTokens = (breakdown: Breakdown): Record<FixedKey, number> => ({
  systemPrompt: breakdown.systemPrompt,
  systemTools: sumParts(breakdown.tools.builtin),
  mcpTools: sumParts(breakdown.tools.mcp),
  extensionTools: sumParts(breakdown.tools.extension),
  memoryFiles: sumParts(breakdown.memoryFiles),
  skills: sumParts(breakdown.skills),
});

const estimatedMessages = (breakdown: Breakdown) =>
  MESSAGE_KEYS.reduce((sum, key) => sum + breakdown.messages[key], 0);

const cacheFigures = (
  lastRequest: PromptTokens | undefined,
  session: PromptTokens,
): CacheFigures | undefined => {
  const sessionHit = sessionCacheHit(session);

  if (sessionHit === undefined) {
    return undefined;
  }

  return {
    lastTurn: lastRequest ? (cacheHitPercent(lastRequest) ?? 0) : undefined,
    lastMissed: lastRequest !== undefined && !reportedCache(lastRequest),
    session: sessionHit,
  };
};

const percentOf = (tokens: number, window: number) => (window > 0 ? (tokens / window) * 100 : 0);

export const usageModel = (snapshot: Snapshot): UsageModel => {
  const { breakdown } = snapshot;
  const local = fixedTokens(breakdown);
  const localSum = Object.values(local).reduce((sum, tokens) => sum + tokens, 0);
  const estimated = breakdown.total === null;
  const measured = breakdown.total ?? 0;
  const fixed = !estimated && localSum > measured ? fitTo(local, measured) : local;
  const messages = estimated ? estimatedMessages(breakdown) : Math.max(0, measured - localSum);
  const used = estimated ? localSum + messages : measured;
  const free = Math.max(0, breakdown.window - used - breakdown.reserve);
  const tokens: Record<CategoryKey, number> = { ...fixed, messages, free, reserve: breakdown.reserve };
  const full = used > breakdown.window - breakdown.reserve;

  const categories = CATEGORY_KEYS.filter((key) => tokens[key] > 0 || (key === "free" && full)).map(
    (key) => ({ key, tokens: tokens[key], percent: percentOf(tokens[key], breakdown.window) }),
  );

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
