import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { type CommandRunner, errorMessage, LauncherError } from "../shared/index.ts";
import type { Workspace } from "./types.ts";

const realPath = async (path: string) => {
  try {
    return await realpath(path);
  } catch (error) {
    throw new LauncherError(`${path}: ${errorMessage(error)}`);
  }
};

export const discoverWorkspace = async (cwd: string, runner: CommandRunner): Promise<Workspace> => {
  const realCwd = await realPath(cwd);
  const result = await runner.run("git", ["rev-parse", "--show-toplevel", "--git-common-dir"], {
    cwd: realCwd,
  });
  const [toplevel = "", commonDir = ""] = result.stdout.split("\n").map((line) => line.trim());

  if (result.code !== 0 || toplevel === "" || commonDir === "") {
    return { cwd: realCwd, repoRoot: realCwd, isGitRepo: false };
  }

  return {
    cwd: realCwd,
    repoRoot: await realPath(toplevel),
    gitCommonDir: await realPath(resolve(realCwd, commonDir)),
    isGitRepo: true,
  };
};
