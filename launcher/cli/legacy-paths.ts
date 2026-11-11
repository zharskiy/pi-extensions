import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { legacyLauncherPaths } from "../shared/index.ts";
import { type CliDeps, pathsOf } from "./deps.ts";

const kindOf = (path: string) =>
  stat(path).then(
    (info) => (info.isDirectory() ? "directory" : "file"),
    () => undefined,
  );

const isOther = (path: string, current: string) => resolve(path) !== resolve(current);

interface LegacyPath {
  problem: string;
  fix: string;
}

const noticeOf = (legacy: LegacyPath) => `${legacy.problem}; ${legacy.fix}`;

export const movedConfig = async (deps: CliDeps): Promise<LegacyPath[]> => {
  const legacy = legacyLauncherPaths(deps.home).userConfigFile;
  const current = pathsOf(deps).userConfigFile;

  if (!isOther(legacy, current)) {
    return [];
  }

  const [old, now] = await Promise.all([kindOf(legacy), kindOf(current)]);

  return old === "file" && now === undefined
    ? [{ problem: `${legacy} is no longer read`, fix: `move it to ${current}` }]
    : [];
};

export const movedConfigNotice = async (deps: CliDeps) => (await movedConfig(deps)).map(noticeOf);

export const leftoverState = async (deps: CliDeps): Promise<LegacyPath[]> => {
  const legacy = legacyLauncherPaths(deps.home).stateDir;
  const current = pathsOf(deps).stateDir;

  if (!isOther(legacy, current) || (await kindOf(legacy)) !== "directory") {
    return [];
  }

  return [
    {
      problem: `${legacy} is no longer used, the launcher keeps its state in ${current}`,
      fix: "delete it once no pi session started before the move runs",
    },
  ];
};
