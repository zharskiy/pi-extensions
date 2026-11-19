import { MAX_DAYS } from "./settings.ts";

export const INTERVALS = [7, 30, 60, 90, 180, 365];

const APPLY = "apply";

const DAYS = /^[1-9]\d*$/;

export type PruneArgs = { days?: number; apply: boolean };

const validDays = (word: string) =>
  DAYS.test(word) && Number(word) >= INTERVALS[0] && Number(word) <= MAX_DAYS;

export const parseArgs = (text: string): PruneArgs | undefined => {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const apply = words.at(-1) === APPLY;
  const [first, ...rest] = apply ? words.slice(0, -1) : words;

  if (first === undefined) {
    return { apply };
  }

  return rest.length === 0 && validDays(first) ? { days: Number(first), apply } : undefined;
};

export const completeArgs = (prefix: string) => {
  const words = prefix.trimStart().split(/\s+/);
  const last = words.pop() ?? "";
  const head = words.length > 0 ? `${words.join(" ")} ` : "";
  const afterDays = words.length === 1 && validDays(words[0]);
  const options = words.length === 0 ? [...INTERVALS.map(String), APPLY] : afterDays ? [APPLY] : [];
  const matches = options.filter((option) => option.startsWith(last));

  return matches.length > 0 ? matches.map((option) => ({ value: `${head}${option}`, label: option })) : null;
};
