import { mkdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { validateConfig } from "../../config/index.ts";
import {
  errorMessage,
  isJsonObject,
  type JsonObject,
  LauncherError,
  writeFileAtomic,
} from "../../shared/index.ts";
import type { Change, ConfigDocument, DocumentRead } from "./types.ts";

const DEFAULT_INDENT = "  ";

const CONFIG_MODE = 0o600;

const CONFIG_DIR_MODE = 0o700;

const PERMISSION_BITS = 0o777;

const INDENTED_LINE = /^([ \t]+)\S/m;

const OWNED_PATHS = [
  ["workspaceRoots"],
  ["vm", "cpus"],
  ["vm", "memoryGiB"],
  ["vm", "diskGiB"],
  ["writeBack", "enabled"],
] as const;

const childOf = (value: JsonObject, key: string) => {
  const child = value[key];

  return isJsonObject(child) ? child : undefined;
};

export const valueAt = (value: JsonObject, path: readonly string[]): unknown => {
  const [head, ...rest] = path;

  if (rest.length === 0) {
    return Object.hasOwn(value, head) ? value[head] : undefined;
  }

  const child = childOf(value, head);

  return child === undefined ? undefined : valueAt(child, rest);
};

export const withValue = (value: JsonObject, path: readonly string[], next: unknown): JsonObject => {
  const [head, ...rest] = path;

  if (rest.length === 0) {
    return { ...value, [head]: next };
  }

  return { ...value, [head]: withValue(childOf(value, head) ?? {}, rest, next) };
};

export const withoutValue = (value: JsonObject, path: readonly string[]): JsonObject => {
  const [head, ...rest] = path;

  if (!Object.hasOwn(value, head)) {
    return value;
  }

  const kept = Object.fromEntries(Object.entries(value).filter(([key]) => key !== head));

  if (rest.length === 0) {
    return kept;
  }

  const child = childOf(value, head);

  if (child === undefined) {
    return value;
  }

  const trimmed = withoutValue(child, rest);

  if (trimmed === child) {
    return value;
  }

  return Object.keys(trimmed).length === 0 ? kept : { ...value, [head]: trimmed };
};

export const withoutOwned = (value: JsonObject) => OWNED_PATHS.reduce(withoutValue, value);

const indentOf = (text: string) => {
  const leading = INDENTED_LINE.exec(text)?.[1];

  if (leading === undefined) {
    return DEFAULT_INDENT;
  }

  return leading.startsWith("\t") ? "\t" : leading;
};

const outsideProblem = (value: JsonObject) => {
  try {
    validateConfig(withoutOwned(value));

    return undefined;
  } catch (error) {
    return errorMessage(error);
  }
};

const parsed = (text: string): { value: unknown } | { message: string } => {
  try {
    return { value: JSON.parse(text) as unknown };
  } catch (error) {
    return { message: errorMessage(error) };
  }
};

export const readDocument = (file: string, text: string | undefined): DocumentRead => {
  if (text === undefined) {
    return { ok: true, document: { file, text, value: {}, indent: DEFAULT_INDENT, newline: true } };
  }

  const result = parsed(text);

  if ("message" in result) {
    return { ok: false, kind: "json", message: result.message };
  }

  if (!isJsonObject(result.value)) {
    return { ok: false, kind: "json", message: "the file holds JSON, but not an object" };
  }

  const problem = outsideProblem(result.value);

  if (problem !== undefined) {
    return { ok: false, kind: "config", message: problem };
  }

  const document = { file, text, value: result.value, indent: indentOf(text), newline: text.endsWith("\n") };

  return { ok: true, document };
};

export const serialise = (document: ConfigDocument, value: JsonObject) =>
  `${JSON.stringify(value, null, document.indent)}${document.newline ? "\n" : ""}`;

export const isReindented = (document: ConfigDocument) =>
  document.text !== undefined && serialise(document, document.value) !== document.text;

const joined = (prefix: string, key: string) => (prefix === "" ? key : `${prefix}.${key}`);

const changesAt = (before: unknown, after: unknown, key: string): Change[] => {
  if (isJsonObject(before) && isJsonObject(after)) {
    return diffBetween(before, after, key);
  }

  if (isDeepStrictEqual(before, after)) {
    return [];
  }

  if (before === undefined) {
    return isJsonObject(after) ? diffBetween({}, after, key) : [{ key, kind: "add", after }];
  }

  if (after === undefined) {
    return isJsonObject(before) ? diffBetween(before, {}, key) : [{ key, kind: "remove", before }];
  }

  return [{ key, kind: "change", before, after }];
};

const diffBetween = (before: JsonObject, after: JsonObject, prefix: string): Change[] => {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];

  return keys.flatMap((key) =>
    changesAt(
      Object.hasOwn(before, key) ? before[key] : undefined,
      Object.hasOwn(after, key) ? after[key] : undefined,
      joined(prefix, key),
    ),
  );
};

export const diffOf = (before: JsonObject, after: JsonObject) => diffBetween(before, after, "");

const currentText = (file: string) => readFile(file, "utf8").catch(() => undefined);

const modeOf = async (file: string) => {
  const info = await stat(file).catch(() => undefined);

  return info === undefined ? CONFIG_MODE : info.mode & PERMISSION_BITS;
};

export const writeDocument = async (document: ConfigDocument, text: string) => {
  if ((await currentText(document.file)) !== document.text) {
    throw new LauncherError(
      `could not save ${document.file}: the file changed while setup ran`,
      "run pi sandbox init again to see the new content",
    );
  }

  const target = await realpath(document.file).catch(() => document.file);
  const mode = await modeOf(target);

  await mkdir(dirname(target), { recursive: true, mode: CONFIG_DIR_MODE });

  await writeFileAtomic(target, text, { mode });
};
