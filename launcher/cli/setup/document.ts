import { lstat, mkdir, readFile, readlink, realpath, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
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

const BYTE_ORDER_MARK = "\uFEFF";

const BOM_MESSAGE = "the file starts with a byte-order mark (BOM); save it as UTF-8 without one";

const WRITE_CODE = /\b(EACCES|EPERM|EROFS|ENOSPC)\b/;

const WRITE_REASONS: Record<string, { reason: string; hint: string }> = {
  EACCES: {
    reason: "its folder is not writable",
    hint: "fix the folder's permissions, then run pi sandbox init again",
  },
  EPERM: {
    reason: "its folder is not writable",
    hint: "fix the folder's permissions, then run pi sandbox init again",
  },
  EROFS: { reason: "its disk is read-only", hint: "make the disk writable, then run pi sandbox init again" },
  ENOSPC: { reason: "its disk is full", hint: "free some space, then run pi sandbox init again" },
};

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

  if (text.startsWith(BYTE_ORDER_MARK)) {
    return { ok: false, kind: "json", message: BOM_MESSAGE };
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

  const document = {
    file,
    text,
    value: result.value,
    indent: indentOf(text),
    newline: text.endsWith("\n"),
    ...(text.includes("\r\n") ? { crlf: true } : {}),
  };

  return { ok: true, document };
};

export const serialise = (document: ConfigDocument, value: JsonObject) => {
  const text = `${JSON.stringify(value, null, document.indent)}${document.newline ? "\n" : ""}`;

  return document.crlf === true ? text.replaceAll("\n", "\r\n") : text;
};

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

const isFolder = async (path: string) => (await stat(path).catch(() => undefined))?.isDirectory() === true;

const targetOf = async (file: string) => {
  const real = await realpath(file).catch(() => undefined);

  if (real !== undefined) {
    return real;
  }

  const info = await lstat(file).catch(() => undefined);

  if (info?.isSymbolicLink() !== true) {
    return file;
  }

  const target = resolve(dirname(file), await readlink(file));

  if (!(await isFolder(dirname(target)))) {
    throw new LauncherError(
      `could not save ${file}: it is a link to ${target}, whose folder does not exist`,
      "create that folder, or replace the link with a file",
    );
  }

  return target;
};

const saveError = (file: string, target: string, error: unknown) => {
  const message = errorMessage(error);
  const known = WRITE_REASONS[WRITE_CODE.exec(message)?.[1] ?? ""];

  if (known !== undefined) {
    return new LauncherError(`could not save ${file}: ${known.reason}`, known.hint);
  }

  return new LauncherError(`could not save ${file}: ${message.replace(`${target}: `, "")}`);
};

export const writeDocument = async (document: ConfigDocument, text: string) => {
  if ((await currentText(document.file)) !== document.text) {
    throw new LauncherError(
      `could not save ${document.file}: the file changed while setup ran`,
      "run pi sandbox init again to see the new content",
    );
  }

  const target = await targetOf(document.file);
  const mode = await modeOf(target);

  try {
    await mkdir(dirname(target), { recursive: true, mode: CONFIG_DIR_MODE });

    await writeFileAtomic(target, text, { mode });
  } catch (error) {
    throw saveError(document.file, target, error);
  }
};
