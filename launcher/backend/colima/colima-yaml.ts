import { resolve } from "node:path";
import { expandHome } from "../../shared/index.ts";
import type { VmShare } from "../types.ts";

type MountEntry = Record<string, string>;

const MOUNTS_KEY = /^mounts:\s*(.*)$/;

const ENTRY_KEY = /^([A-Za-z0-9_]+):\s*(.*)$/;

const QUOTED = /^(["'])(.*?)\1(?:\s+#.*)?$/;

const INLINE_COMMENT = /(?:^|\s+)#.*$/;

const TRUE = /^(?:true|yes|on)$/i;

const EMPTY_VALUES = ["", "null", "~"];

const yamlValue = (raw: string) => {
  const quoted = QUOTED.exec(raw);

  return quoted === null ? raw.replace(INLINE_COMMENT, "") : (quoted[2] ?? "");
};

const isTopLevel = (line: string) => line !== "" && !/^[\s-]/.test(line);

const mountsBlock = (text: string) => {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "" && !line.trimStart().startsWith("#"));
  const start = lines.findIndex((line) => MOUNTS_KEY.test(line));

  if (start === -1) {
    return undefined;
  }

  const inline = yamlValue(MOUNTS_KEY.exec(lines[start] ?? "")?.[1]?.trim() ?? "");
  const rest = lines.slice(start + 1);
  const end = rest.findIndex(isTopLevel);

  if (inline !== "") {
    return inline === "[]" || EMPTY_VALUES.includes(inline) ? [] : "flow";
  }

  return rest.slice(0, end === -1 ? rest.length : end);
};

const groupedEntries = (block: string[]) => {
  const lines = block.map((line) => line.trimStart());
  const starts = lines.flatMap((line, index) => (line.startsWith("-") ? [index] : []));

  return starts.map((start, position) => {
    const entry = lines.slice(start, starts[position + 1] ?? lines.length);

    return [(entry[0] ?? "").slice(1).trim(), ...entry.slice(1)];
  });
};

const entryOf = (lines: string[]): MountEntry => {
  const pairs = lines.flatMap((line) => {
    const match = ENTRY_KEY.exec(line);

    return match === null ? [] : [[match[1] ?? "", yamlValue((match[2] ?? "").trim())] as const];
  });

  return Object.fromEntries(pairs);
};

const mountEntriesOf = (text: string) => {
  const block = mountsBlock(text);

  if (block === undefined || block === "flow") {
    return block;
  }

  const entries = groupedEntries(block).map(entryOf);

  return entries.every((entry) => entry.location !== undefined) ? entries : "flow";
};

const shareOf = (entry: MountEntry, home: string): VmShare[] => {
  const location = entry.location;

  return location === undefined || location === ""
    ? []
    : [{ location: resolve(expandHome(location, home)), writable: TRUE.test(entry.writable ?? "") }];
};

export const vmSharesOf = (text: string, home: string) => {
  const entries = mountEntriesOf(text);

  return entries === undefined || entries === "flow"
    ? undefined
    : entries.flatMap((entry) => shareOf(entry, home));
};

const isMoved = (entry: MountEntry, home: string) => {
  const mountPoint = entry.mountPoint ?? "";

  return (
    !EMPTY_VALUES.includes(mountPoint) &&
    shareOf(entry, home).some((share) => share.location !== resolve(expandHome(mountPoint, home)))
  );
};

export const movedMountsOf = (text: string, home: string) => {
  const entries = mountEntriesOf(text);

  return entries === undefined || entries === "flow"
    ? []
    : entries.filter((entry) => isMoved(entry, home)).map((entry) => entry.location ?? "");
};
