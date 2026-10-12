export type FrontmatterValue = string | number | boolean | string[];

type Frontmatter = { data: Record<string, FrontmatterValue>; body: string };

const unquote = (value: string) => {
  const quoted = /^"(.*)"$|^'(.*)'$/s.exec(value);

  if (!quoted) {
    return value;
  }

  return quoted[1] ?? quoted[2] ?? "";
};

export const parseScalar = (raw: string): FrontmatterValue => {
  const value = raw.trim();

  if (value.startsWith("[") && value.endsWith("]")) {
    return value
      .slice(1, -1)
      .split(",")
      .map((item) => unquote(item.trim()))
      .filter((item) => item.length > 0);
  }

  if (value === "true" || value === "false") {
    return value === "true";
  }

  if (/^-?\d+(\.\d+)?$/.test(value)) {
    return Number(value);
  }

  return unquote(value);
};

const indentOf = (line: string) => line.length - line.trimStart().length;

type ParseState = { data: Record<string, FrontmatterValue>; index: number };

const readBlock = (lines: string[], start: number) => {
  const block = lines.slice(start);
  const end = block.findIndex((line) => line.trim().length > 0 && indentOf(line) === 0);
  const taken = end < 0 ? block : block.slice(0, end);

  return taken;
};

const parseEntry = (lines: string[], state: ParseState) => {
  const line = lines[state.index];
  const match = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);

  state.index += 1;

  if (!match) {
    return;
  }

  const [, key, rest] = match;
  const value = rest.trim();

  if (value === "|" || value === ">") {
    const block = readBlock(lines, state.index);
    const indent = Math.min(...block.filter((item) => item.trim()).map(indentOf));
    const joiner = value === "|" ? "\n" : " ";

    state.index += block.length;
    state.data[key] = block
      .map((item) => item.slice(Number.isFinite(indent) ? indent : 0))
      .join(joiner)
      .trim();

    return;
  }

  if (value.length > 0) {
    state.data[key] = parseScalar(value);
    return;
  }

  const block = readBlock(lines, state.index);
  const filled = block.filter((item) => item.trim().length > 0);
  const items = filled.filter((item) => item.trim().startsWith("- "));

  state.index += block.length;

  if (filled.length === 0) {
    return;
  }

  state.data[key] =
    items.length > 0
      ? items.map((item) => unquote(item.trim().slice(2).trim()))
      : filled.map((item) => item.trim()).join(" ");
};

export const parseFrontmatter = (source: string): Frontmatter => {
  const normalized = source.replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normalized);

  if (!match) {
    return { data: {}, body: normalized.trim() };
  }

  const lines = match[1].split("\n");
  const state: ParseState = { data: {}, index: 0 };

  const step = () => {
    if (state.index >= lines.length) {
      return;
    }

    parseEntry(lines, state);
    step();
  };

  step();

  return { data: state.data, body: match[2].trim() };
};
