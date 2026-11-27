import { stat } from "node:fs/promises";
import { join } from "node:path";
import { gitValue } from "../../provision/index.ts";
import type { CliDeps } from "../deps.ts";
import { type Steps, tilde } from "../steps.ts";
import { setBlock } from "./path-block.ts";

export const gitSettingsFile = (packageDir: string) =>
  join(packageDir, "launcher", "cli", "pinata", "gitconfig");

const kindOf = async (path: string) => {
  const info = await stat(path).catch(() => undefined);

  return info === undefined ? "absent" : info.isFile() ? "file" : "other";
};

const globalConfig = async (deps: CliDeps) => {
  const configured = deps.env.GIT_CONFIG_GLOBAL;

  if (configured !== undefined && configured !== "") {
    return { file: configured, kind: await kindOf(configured) };
  }

  const home = join(deps.home, ".gitconfig");
  const homeKind = await kindOf(home);
  const xdg = join(deps.env.XDG_CONFIG_HOME || join(deps.home, ".config"), "git", "config");

  if (homeKind !== "file" && (await kindOf(xdg)) === "file") {
    return { file: xdg, kind: "file" };
  }

  return { file: home, kind: homeKind };
};

export const setGitBlock = async (deps: CliDeps, steps: Steps, packageDir: string, add: boolean) => {
  const { file, kind } = await globalConfig(deps);

  if (kind === "other") {
    if (add) {
      steps.warn(`Left git's global settings alone: ${tilde(deps, file)} is not a regular file`);
    }

    return;
  }

  await setBlock(
    deps,
    steps,
    {
      file,
      body: ['[includeIf "gitdir:/"]', `\tpath = ${gitValue(gitSettingsFile(packageDir))}`],
      create: true,
      first: true,
      added: `Added pinata's git settings to ${tilde(deps, file)}`,
      removed: `Removed pinata's git settings from ${tilde(deps, file)}`,
    },
    add,
  );
};
