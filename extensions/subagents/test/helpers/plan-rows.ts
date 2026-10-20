export type PlanStatus = "done" | "partial" | "blocked";

export type PlanFile = { path: string; isNew: boolean };

const STATUS = /^[\s>*_#-]*status\s*[:*_]+\s*[*_]*\s*(done|partial|blocked)\b/im;

const ROW = /^[\s>]*(?:[-*]|\d+[.)])\s*[*_`]*agent[*_`]*\s*:/i;

const FILES = /\bfiles[*_`]*\s*:\s*(.*)$/i;

const FIELD = /^\s*[*_`]*[A-Za-z][\w ]*[*_`]*:/;

const HEADING = /^\s*#/;

const BRACES = /([^\s,;{}]*)\{([^{}]*)\}([^\s,;]*)/;

const SEPARATOR = /[,;]|\s+and\s+/;

const NEW_NOTE = /\b(new|create[sd]?|creating|add(ed)?)\b/i;

const PATH = /[./]/;

export const planStatus = (text: string): PlanStatus | undefined =>
  STATUS.exec(text)?.[1]?.toLowerCase() as PlanStatus | undefined;

const expandBraces = (text: string): string => {
  const match = BRACES.exec(text);

  if (!match) {
    return text;
  }

  const [whole, prefix, options, suffix] = match;
  const expanded = options
    .split(",")
    .map((option) => `${prefix}${option.trim()}${suffix}`)
    .join(", ");

  return expandBraces(text.replace(whole, expanded));
};

const continuation = (lines: string[], start: number): string[] => {
  const line = lines[start];

  if (
    line === undefined ||
    !/^\s+\S/.test(line) ||
    ROW.test(line) ||
    FIELD.test(line) ||
    HEADING.test(line)
  ) {
    return [];
  }

  return [line.trim(), ...continuation(lines, start + 1)];
};

const fileLists = (text: string) => {
  const lines = text.split("\n");

  return lines.flatMap((line, index) => {
    const files = ROW.test(line) ? FILES.exec(line)?.[1] : undefined;

    return files === undefined ? [] : [[files, ...continuation(lines, index + 1)].join(", ")];
  });
};

const cleanToken = (token: string) =>
  token
    .replace(/[`"']/g, "")
    .replace(/^\*\*(.*?)\*\*$/, "$1")
    .replace(/^[([]+/, "")
    .replace(/[.,;:)\]]+$/, "")
    .replace(/^\.\//, "")
    .replace(/(:\d+(-\d+)?|#L\d+(-L?\d+)?)$/, "");

const parseEntry = (entry: string): PlanFile | undefined => {
  const tokens = entry.trim().split(/\s+/).map(cleanToken);
  const path = tokens.find((token) => PATH.test(token) && !/^\.+$/.test(token));

  if (!path) {
    return undefined;
  }

  return { path, isNew: NEW_NOTE.test(tokens.filter((token) => token !== path).join(" ")) };
};

export const relativeTo = (roots: string[], path: string) => {
  const root = roots.find((dir) => path.startsWith(`${dir}/`));

  return root ? path.slice(root.length + 1) : path;
};

export const planFiles = (text: string): PlanFile[] => {
  const entries = fileLists(text)
    .flatMap((list) => expandBraces(list).split(SEPARATOR))
    .flatMap((entry) => parseEntry(entry) ?? []);

  const merged = entries.reduce((byPath, entry) => {
    byPath.set(entry.path, {
      path: entry.path,
      isNew: entry.isNew || (byPath.get(entry.path)?.isNew ?? false),
    });

    return byPath;
  }, new Map<string, PlanFile>());

  return [...merged.values()];
};
