import { stat } from "node:fs/promises";
import { join } from "node:path";
import { gitValue } from "../../provision/index.ts";
import { realOrResolved } from "../../shared/index.ts";
import type { CliDeps } from "../deps.ts";
import { type Steps, tilde } from "../steps.ts";
import { type MarkedBlock, setBlock } from "./path-block.ts";

export const gitSettingsFile = (packageDir: string) =>
  join(packageDir, "launcher", "cli", "pinata", "gitconfig");

const kindOf = async (path: string) => {
  const info = await stat(path).catch(() => undefined);

  return info === undefined ? "absent" : info.isFile() ? "file" : "other";
};

const configuredFile = (deps: CliDeps) => {
  const configured = deps.env.GIT_CONFIG_GLOBAL;

  return configured === undefined || configured === "" ? undefined : configured;
};

const userFiles = (deps: CliDeps) => [
  join(deps.env.XDG_CONFIG_HOME || join(deps.home, ".config"), "git", "config"),
  join(deps.home, ".gitconfig"),
];

const globalConfig = async (deps: CliDeps) => {
  const configured = configuredFile(deps);

  if (configured !== undefined) {
    return { file: configured, kind: await kindOf(configured) };
  }

  const [xdg = "", home = ""] = userFiles(deps);

  if ((await kindOf(xdg)) === "file") {
    return { file: xdg, kind: "file" };
  }

  return { file: home, kind: await kindOf(home) };
};

const gitBlock = (deps: CliDeps, packageDir: string, file: string): MarkedBlock => ({
  file,
  body: ['[includeIf "gitdir:/"]', `\tpath = ${gitValue(gitSettingsFile(packageDir))}`],
  create: true,
  first: true,
  added: `Added pinata's git settings to ${tilde(deps, file)}`,
  removed: `Removed pinata's git settings from ${tilde(deps, file)}`,
});

const removeFrom = (deps: CliDeps, steps: Steps, packageDir: string, files: string[]) =>
  files.reduce(
    (previous, file) => previous.then(() => setBlock(deps, steps, gitBlock(deps, packageDir, file), false)),
    Promise.resolve(),
  );

const othersOf = async (files: string[], target: string) => {
  const real = await realOrResolved(target);
  const reals = await Promise.all(files.map(realOrResolved));

  return files.filter((_, index) => reals[index] !== real);
};

export const setGitBlock = async (deps: CliDeps, steps: Steps, packageDir: string, add: boolean) => {
  const configured = configuredFile(deps);
  const files = [...new Set([...(configured === undefined ? [] : [configured]), ...userFiles(deps)])];

  if (!add) {
    return removeFrom(deps, steps, packageDir, files);
  }

  const { file, kind } = await globalConfig(deps);

  if (kind === "other") {
    return steps.warn(`Left git's global settings alone: ${tilde(deps, file)} is not a regular file`);
  }

  await setBlock(deps, steps, gitBlock(deps, packageDir, file), true);

  await removeFrom(deps, steps, packageDir, await othersOf(files, file));
};
