import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CliDeps } from "../deps.ts";
import { say } from "./host.ts";

const BEGIN = "# pinata begin";

const END = "# pinata end";

const setBlock = async (deps: CliDeps, file: string, add: boolean) => {
  const text = await readFile(file, "latin1").catch(() => (add && file.endsWith(".zshrc") ? "" : undefined));

  if (text === undefined) {
    return;
  }

  const lines = text.split("\n");
  const marks = lines.flatMap((line, index) => (line === BEGIN || line === END ? [index] : []));
  const [start = -1, end = -1] = marks;

  if (marks.length > 0 && (marks.length !== 2 || lines[start] !== BEGIN || lines[end] !== END)) {
    return say(deps, `shell: ${file} has a "${BEGIN}" or "${END}" line without its pair, left as it is`);
  }

  const block = `${BEGIN}\nexport PATH='${join(deps.home, ".local", "bin").replaceAll("'", "'\\''")}':"$PATH"\n${END}`;
  const [before, after] = [lines.slice(0, Math.max(start, 0)).join("\n"), lines.slice(end + 1).join("\n")];
  const cut = `${before}${before === "" || before.endsWith("\n") || after === "" ? "" : "\n"}${after}`;
  const placed = [...lines.slice(0, Math.max(start, 0)), block, ...lines.slice(end + 1)].join("\n");
  const next = marks.length === 0 ? (add ? `${text}\n${block}\n` : text) : add ? placed : cut;

  if (next !== text) {
    await writeFile(file, next, "latin1");

    say(deps, `shell: ${add ? "added the PATH block to" : "removed the PATH block from"} ${file}`);
  }
};

export const setPathBlock = (deps: CliDeps, add: boolean) =>
  Promise.all(
    [".zshrc", ".bashrc", ".bash_profile"].map((name) => setBlock(deps, join(deps.home, name), add)),
  );
