import { lstat, mkdir, readFile, readlink, realpath, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { VmSpec } from "../../backend/index.ts";
import { configProblem, withoutPath } from "../../config/index.ts";
import {
  errorMessage,
  isJsonObject,
  type JsonObject,
  LauncherError,
  PERMISSION_BITS,
  PRIVATE_DIR_MODE,
  PRIVATE_FILE_MODE,
  writeFileAtomic,
} from "../../shared/index.ts";
import type { Change, ConfigDocument, DocumentRead, Section } from "./types.ts";

const DEFAULT_INDENT = "  ";

const INDENTED_LINE = /^([ \t]+)\S/m;

const BYTE_ORDER_MARK = "\uFEFF";

const BOM_MESSAGE = "the file starts with a byte-order mark (BOM); save it as UTF-8 without one";

const WRITE_CODE = /\b(EACCES|EPERM|EROFS|ENOSPC)\b/;

const PATH_SUFFIX = /, \w+ '[^']*'( -> '[^']*')?$/;

const LEADING_PATH = /^\/[^:]*: /;

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

export const VM_KEYS: readonly (keyof VmSpec)[] = ["cpus", "memoryGiB", "diskGiB"];

export const WRITE_BACK_PATH = "writeBack.enabled";

const SECTION_PATHS: Record<Section, readonly string[]> = {
  folders: ["workspaceRoots"],
  vm: VM_KEYS.map((key) => `vm.${key}`),
  writeBack: [WRITE_BACK_PATH],
};

export const SECTIONS = Object.keys(SECTION_PATHS) as readonly Section[];

const OWNED_PATHS = SECTIONS.flatMap((section) => SECTION_PATHS[section]);

export const isInSection = (section: Section, key: string) =>
  SECTION_PATHS[section].some((path) => key === path || key.startsWith(`${path}.`));

export const withoutOwned = (value: JsonObject) => OWNED_PATHS.reduce(withoutPath, value);

const indentOf = (text: string) => {
  const leading = INDENTED_LINE.exec(text)?.[1];

  if (leading === undefined) {
    return DEFAULT_INDENT;
  }

  return leading.startsWith("\t") ? "\t" : leading;
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

  const problem = configProblem(withoutOwned(result.value));

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

const modeOf = async (file: string) => {
  const info = await stat(file).catch(() => undefined);

  return info === undefined ? PRIVATE_FILE_MODE : info.mode & PERMISSION_BITS;
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

const reasonOf = (error: unknown) => errorMessage(error).replace(LEADING_PATH, "").replace(PATH_SUFFIX, "");

const currentText = async (file: string) => {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }

    throw error;
  }
};

export const readConfigText = (file: string) =>
  currentText(file).catch((error: unknown) => {
    throw new LauncherError(`could not read ${file}: ${reasonOf(error)}`);
  });

const saveError = (file: string, error: unknown) => {
  const known = WRITE_REASONS[WRITE_CODE.exec(errorMessage(error))?.[1] ?? ""];

  if (known !== undefined) {
    return new LauncherError(`could not save ${file}: ${known.reason}`, known.hint);
  }

  return new LauncherError(`could not save ${file}: ${reasonOf(error)}`);
};

export const writeDocument = async (document: ConfigDocument, text: string) => {
  const current = await currentText(document.file).catch((error: unknown) => {
    throw new LauncherError(`could not save ${document.file}: could not read it: ${reasonOf(error)}`);
  });

  if (current !== document.text) {
    throw new LauncherError(
      `could not save ${document.file}: the file changed while setup ran`,
      "run pi sandbox init again to see the new content",
    );
  }

  const target = await targetOf(document.file);
  const mode = await modeOf(target);

  try {
    await mkdir(dirname(target), { recursive: true, mode: PRIVATE_DIR_MODE });

    await writeFileAtomic(target, text, { mode });
  } catch (error) {
    throw saveError(document.file, error);
  }
};
