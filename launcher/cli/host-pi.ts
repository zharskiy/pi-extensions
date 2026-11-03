import { constants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { isWithin, launcherRoot } from "../shared/index.ts";

const WRAPPER_LIMIT = 4096;

const WRAPPER_MARKER = "launcher/bin/pi-sandbox";

const isExecutable = (path: string) =>
  access(path, constants.X_OK).then(
    () => true,
    () => false,
  );

const isWrapper = async (path: string) => {
  const info = await stat(path);

  if (!info.isFile() || info.size > WRAPPER_LIMIT) {
    return false;
  }

  return (await readFile(path, "utf8")).includes(WRAPPER_MARKER);
};

const isLauncher = async (path: string, ownBinDir: string) => {
  const real = await realpath(path);

  return isWithin(real, ownBinDir) || (await isWrapper(real));
};

const isHostPi = async (path: string, ownBinDir: string) =>
  (await isExecutable(path)) && !(await isLauncher(path, ownBinDir).catch(() => true));

export const findHostPi = async (env: NodeJS.ProcessEnv) => {
  const ownBinDir = await realpath(join(launcherRoot(), "bin")).catch(() => join(launcherRoot(), "bin"));
  const candidates = (env.PATH ?? "")
    .split(delimiter)
    .filter((dir) => dir !== "")
    .map((dir) => join(dir, "pi"));
  const verdicts = await Promise.all(candidates.map((path) => isHostPi(path, ownBinDir)));

  return candidates.find((_, index) => verdicts[index]);
};
