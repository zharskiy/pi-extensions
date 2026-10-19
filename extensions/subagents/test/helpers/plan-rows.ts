export type PlanStatus = "done" | "partial" | "blocked";

const STATUS = /^[\s>*_#-]*status\s*[:*_]+\s*[*_]*\s*(done|partial|blocked)\b/im;

const ROW = /^[\s>]*[-*]\s*[*_`]*agent[*_`]*\s*:/i;

const FILES = /\bfiles[*_`]*\s*:\s*(.*)$/i;

export const planStatus = (text: string): PlanStatus | undefined =>
  STATUS.exec(text)?.[1]?.toLowerCase() as PlanStatus | undefined;

const cleanPath = (entry: string) =>
  entry
    .trim()
    .replace(/[`*]/g, "")
    .split(/\s+/)[0]
    .replace(/^\.\//, "")
    .replace(/:\d+(-\d+)?$/, "");

export const planFiles = (text: string) => {
  const entries = text
    .split("\n")
    .filter((line) => ROW.test(line))
    .flatMap((line) => FILES.exec(line)?.[1]?.split(",") ?? [])
    .map(cleanPath)
    .filter((path) => path.length > 0 && path.toLowerCase() !== "none");

  return [...new Set(entries)];
};
