import type { PromptTokens } from "../../../core/adapter/contract.ts";
import { isPlainObject } from "../../../core/manager/guards.ts";
import { type Breakdown, MESSAGE_KEYS, type Part } from "./buckets.ts";

export type Snapshot = {
  breakdown: Breakdown;
  lastRequest: PromptTokens | undefined;
  session: PromptTokens;
  timestamp: number;
  expandedByDefault: boolean;
};

type Fields = Record<string, unknown>;

const USAGE_KEYS = ["input", "cacheRead", "cacheWrite", "output"];

const MESSAGE_FIELDS = ["count", ...MESSAGE_KEYS];

const numbers = (value: unknown, keys: readonly string[]) =>
  isPlainObject(value) && keys.every((key) => typeof value[key] === "number");

const isPart = (value: unknown): value is Part =>
  numbers(value, ["tokens"]) && typeof (value as Fields).name === "string";

const isParts = (value: unknown): value is Part[] => Array.isArray(value) && value.every(isPart);

const isUsage = (value: unknown): value is PromptTokens => numbers(value, USAGE_KEYS);

const isTools = (value: unknown) =>
  isPlainObject(value) && isParts(value.builtin) && isParts(value.mcp) && isParts(value.extension);

const isBreakdown = (value: unknown): value is Breakdown =>
  numbers(value, ["window", "reserve", "systemPrompt"]) &&
  isPlainObject(value) &&
  (value.total === null || typeof value.total === "number") &&
  (value.model === undefined || typeof value.model === "string") &&
  isParts(value.memoryFiles) &&
  isParts(value.skills) &&
  isTools(value.tools) &&
  numbers(value.messages, MESSAGE_FIELDS);

export const parseSnapshot = (data: unknown): Snapshot | undefined => {
  if (!isPlainObject(data) || !isBreakdown(data.breakdown) || !isUsage(data.session)) {
    return undefined;
  }

  return {
    breakdown: data.breakdown,
    lastRequest: isUsage(data.lastRequest) ? data.lastRequest : undefined,
    session: data.session,
    timestamp: typeof data.timestamp === "number" ? data.timestamp : 0,
    expandedByDefault: data.expandedByDefault === true,
  };
};
