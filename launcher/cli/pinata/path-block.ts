import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CliDeps } from "../deps.ts";
import { type Steps, tilde } from "../steps.ts";

const BEGIN = "# pinata begin";

const END = "# pinata end";

const setBlock = async (deps: CliDeps, steps: Steps, file: string, add: boolean) => {
  const text = await readFile(file, "latin1").catch(() => (add && file.endsWith(".zshrc") ? "" : undefined));

  if (text === undefined) {
    return;
  }

  const lines = text.split("\n");
  const marks = lines.flatMap((line, index) => (line === BEGIN || line === END ? [index] : []));
  const [start = -1, end = -1] = marks;

  if (marks.length > 0 && (marks.length !== 2 || lines[start] !== BEGIN || lines[end] !== END)) {
    return steps.warn(
      `Left ${tilde(deps, file)} as it is: it has a "${BEGIN}" or "${END}" line without its pair`,
    );
  }

  const block = `${BEGIN}\nexport PATH='${join(deps.home, ".local", "bin").replaceAll("'", "'\\''")}':"$PATH"\n${END}`;
  const [before, after] = [lines.slice(0, Math.max(start, 0)).join("\n"), lines.slice(end + 1).join("\n")];
  const cut = `${before}${before === "" || before.endsWith("\n") || after === "" ? "" : "\n"}${after}`;
  const placed = [...lines.slice(0, Math.max(start, 0)), block, ...lines.slice(end + 1)].join("\n");
  const next = marks.length === 0 ? (add ? `${text}\n${block}\n` : text) : add ? placed : cut;

  if (next !== text) {
    await writeFile(file, next, "latin1");

    steps.done(
      add
        ? `Added ${tilde(deps, join(deps.home, ".local", "bin"))} to PATH in ${tilde(deps, file)}`
        : `Removed the PATH block from ${tilde(deps, file)}`,
    );
  }
};

export const setPathBlock = (deps: CliDeps, steps: Steps, add: boolean) =>
  [".zshrc", ".bashrc", ".bash_profile"].reduce(
    (previous, name) => previous.then(() => setBlock(deps, steps, join(deps.home, name), add)),
    Promise.resolve(),
  );
