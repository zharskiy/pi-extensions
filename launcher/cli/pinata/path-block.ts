import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
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

const appended = (text: string, block: string, first: boolean) =>
  first ? `${block}\n${text}` : `${text}\n${block}\n`;

export const setBlock = async (deps: CliDeps, steps: Steps, target: MarkedBlock, add: boolean) => {
  const text = await readFile(target.file, "latin1").catch(() => (add && target.create ? "" : undefined));

  if (text === undefined) {
    return;
  }

  const lines = text.split("\n");
  const marks = lines.flatMap((line, index) => (line === BEGIN || line === END ? [index] : []));
  const [start = -1, end = -1] = marks;

  if (marks.length > 0 && (marks.length !== 2 || lines[start] !== BEGIN || lines[end] !== END)) {
    return steps.warn(
      `Left ${tilde(deps, target.file)} as it is: it has a "${BEGIN}" or "${END}" line without its pair`,
    );
  }

  const body = target.body.map((line) => Buffer.from(line, "utf8").toString("latin1"));
  const block = [BEGIN, ...body, END].join("\n");
  const [before, after] = [lines.slice(0, Math.max(start, 0)).join("\n"), lines.slice(end + 1).join("\n")];
  const cut = `${before}${before === "" || before.endsWith("\n") || after === "" ? "" : "\n"}${after}`;
  const placed = [...lines.slice(0, Math.max(start, 0)), block, ...lines.slice(end + 1)].join("\n");
  const next = marks.length === 0 ? (add ? appended(text, block, target.first) : text) : add ? placed : cut;

  if (next !== text) {
    await writeFile(target.file, next, "latin1");

    steps.done(add ? target.added : target.removed);
  }
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
