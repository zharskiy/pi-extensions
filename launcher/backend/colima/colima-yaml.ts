import { resolve } from "node:path";
import { expandHome } from "../../shared/index.ts";
import type { VmShare, VmSize } from "../types.ts";

type MountEntry = Record<string, string>;

const MOUNTS_KEY = /^mounts:\s*(.*)$/;

const ENTRY_KEY = /^([A-Za-z0-9_]+):\s*(.*)$/;

const SINGLE_QUOTED = /^'((?:[^']|'')*)'(?:\s+#.*)?$/;

const DOUBLE_QUOTED = /^"((?:[^"\\]|\\.)*)"(?:\s+#.*)?$/;

const DOUBLE_ESCAPE = /\\(["\\])/g;

const INLINE_COMMENT = /(?:^|\s+)#.*$/;

const TRUE = /^(?:true|yes|on)$/i;

const EMPTY_VALUES = ["", "null", "~"];

const yamlValue = (raw: string) => {
  const single = SINGLE_QUOTED.exec(raw);

  if (single !== null) {
    return (single[1] ?? "").replaceAll("''", "'");
  }

  const double = DOUBLE_QUOTED.exec(raw);

  return double === null ? raw.replace(INLINE_COMMENT, "") : (double[1] ?? "").replace(DOUBLE_ESCAPE, "$1");
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

const guestPathOf = (path: string, home: string) => resolve(expandHome(path, home));

const mountPointOf = (entry: MountEntry, location: string, home: string) => {
  const mountPoint = entry.mountPoint ?? "";

  if (EMPTY_VALUES.includes(mountPoint)) {
    return undefined;
  }

  const guestPath = guestPathOf(mountPoint, home);

  return guestPath === location ? undefined : guestPath;
};

const shareOf = (entry: MountEntry, home: string): VmShare[] => {
  const raw = entry.location;

  if (raw === undefined || raw === "") {
    return [];
  }

  const location = guestPathOf(raw, home);
  const writable = TRUE.test(entry.writable ?? "");
  const mountPoint = mountPointOf(entry, location, home);

  return [mountPoint === undefined ? { location, writable } : { location, writable, mountPoint }];
};

export const vmSharesOf = (text: string, home: string) => {
  const entries = mountEntriesOf(text);

  return entries === undefined || entries === "flow"
    ? undefined
    : entries.flatMap((entry) => shareOf(entry, home));
};

const sizeValue = (text: string, key: string) => {
  const match = new RegExp(`^${key}:\\s*(\\d+(?:\\.\\d+)?)\\s*(?:#.*)?$`, "m").exec(text);

  return match === null ? undefined : Number(match[1]);
};

export const vmSizeOfYaml = (text: string): VmSize | undefined => {
  const cpus = sizeValue(text, "cpu");
  const memoryGiB = sizeValue(text, "memory");
  const diskGiB = sizeValue(text, "disk");

  if (cpus === undefined || memoryGiB === undefined) {
    return undefined;
  }

  return diskGiB === undefined ? { cpus, memoryGiB } : { cpus, memoryGiB, diskGiB };
};
