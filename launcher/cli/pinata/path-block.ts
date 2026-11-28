import { randomBytes } from "node:crypto";
import { open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage, lstatOrUndefined } from "../../shared/index.ts";
import type { CliDeps } from "../deps.ts";
import { type Steps, tilde } from "../steps.ts";

const BEGIN = "# pinata begin";

const END = "# pinata end";

export interface MarkedBlock {
  file: string;
  body: string[];
  create: boolean;
  first: boolean;
  added: string;
  removed: string;
}

const BYTE_ORDER_MARK = "\xef\xbb\xbf";

const NEW_FILE_MODE = 0o666;

const appended = (text: string, block: string, first: boolean) =>
  first ? `${block}\n${text}` : `${text}\n${block}\n`;

const isMark = (line: string | undefined, mark: string) => line === mark || line === `${mark}\r`;

const reasonOf = (error: unknown) => errorMessage(error).split(",")[0];

const realFileOf = async (file: string) => {
  const info = await lstatOrUndefined(file);

  if (info === undefined || !info.isSymbolicLink()) {
    return file;
  }

  return realpath(file).catch(() => undefined);
};

const writeTemporary = async (temporary: string, text: string, mode: number | undefined) => {
  const handle = await open(temporary, "wx", mode ?? NEW_FILE_MODE);

  try {
    await handle.writeFile(text, "latin1");

    if (mode !== undefined) {
      await handle.chmod(mode);
    }
  } finally {
    await handle.close();
  }
};

const replaceFile = async (file: string, text: string, mode: number | undefined) => {
  const temporary = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;

  try {
    await writeTemporary(temporary, text, mode);

    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });

    throw error;
  }
};

const withBlock = (text: string, target: MarkedBlock, add: boolean) => {
  const lines = text.split("\n");
  const marks = lines.flatMap((line, index) => (isMark(line, BEGIN) || isMark(line, END) ? [index] : []));
  const [start = -1, end = -1] = marks;

  if (marks.length > 0 && (marks.length !== 2 || !isMark(lines[start], BEGIN) || !isMark(lines[end], END))) {
    return undefined;
  }

  const body = target.body.map((line) => Buffer.from(line, "utf8").toString("latin1"));
  const block = [BEGIN, ...body, END].join("\n");
  const [before, after] = [lines.slice(0, Math.max(start, 0)).join("\n"), lines.slice(end + 1).join("\n")];
  const cut = `${before}${before === "" || before.endsWith("\n") || after === "" ? "" : "\n"}${after}`;
  const placed = [...lines.slice(0, Math.max(start, 0)), block, ...lines.slice(end + 1)].join("\n");

  return marks.length === 0 ? (add ? appended(text, block, target.first) : text) : add ? placed : cut;
};

export const setBlock = async (deps: CliDeps, steps: Steps, target: MarkedBlock, add: boolean) => {
  const shown = tilde(deps, target.file);
  const file = await realFileOf(target.file);

  if (file === undefined) {
    if (add) {
      steps.warn(`Left ${shown} alone: it is a link to a file that does not exist`);
    }

    return;
  }

  const info = await stat(file).catch(() => undefined);

  if (info === undefined && !(add && target.create)) {
    return;
  }

  const text = info === undefined ? "" : await readFile(file, "latin1").catch(() => undefined);

  if (text === undefined) {
    if (add) {
      steps.warn(`Left ${shown} as it is: it cannot be read`);
    }

    return;
  }

  const bom = text.startsWith(BYTE_ORDER_MARK) ? BYTE_ORDER_MARK : "";
  const placed = withBlock(text.slice(bom.length), target, add);

  if (placed === undefined) {
    return steps.warn(`Left ${shown} as it is: it has a "${BEGIN}" or "${END}" line without its pair`);
  }

  const next = `${bom}${placed}`;

  if (next === text) {
    return;
  }

  const failure = await replaceFile(file, next, info === undefined ? undefined : info.mode & 0o7777).then(
    () => undefined,
    reasonOf,
  );

  if (failure !== undefined) {
    return steps.warn(`Left ${shown} as it is: writing it failed (${failure})`);
  }

  steps.done(add ? target.added : target.removed);
};

const shellBlock = (deps: CliDeps, file: string): MarkedBlock => {
  const bin = join(deps.home, ".local", "bin");

  return {
    file,
    body: [`export PATH='${bin.replaceAll("'", "'\\''")}':"$PATH"`, "export GIT_OPTIONAL_LOCKS=0"],
    create: file.endsWith(".zshrc"),
    first: false,
    added: `Added ${tilde(deps, bin)} to PATH and GIT_OPTIONAL_LOCKS=0 to ${tilde(deps, file)}`,
    removed: `Removed pinata's block from ${tilde(deps, file)}`,
  };
};

export const setPathBlock = (deps: CliDeps, steps: Steps, add: boolean) =>
  [".zshrc", ".bashrc", ".bash_profile"].reduce(
    (previous, name) =>
      previous.then(() => setBlock(deps, steps, shellBlock(deps, join(deps.home, name)), add)),
    Promise.resolve(),
  );
