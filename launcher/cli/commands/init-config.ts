import { isAbsolute, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isJsonObject, LauncherError, readJsonFile, writeJsonFile } from "../../shared/index.ts";
import { sharedRootsOf } from "../../workspace/index.ts";
import { type CliDeps, hostAgentDirOf, pathsOf } from "../deps.ts";

export const INIT_CONFIG = "__init-config";

const CONFIG_MODE = 0o600;

const isHomeForm = (root: string) => root === "~" || root.startsWith("~/");

const storedRoot = (deps: CliDeps, root: string) =>
  isAbsolute(root) || isHomeForm(root) ? root : resolve(deps.cwd, root);

const rootsIn = (config: unknown) => {
  const workspaceRoots = isJsonObject(config) ? config.workspaceRoots : undefined;

  return isJsonObject(workspaceRoots) ? workspaceRoots.roots : undefined;
};

export const initConfigCommand = async (deps: CliDeps, args: string[]) => {
  if (args.length === 0) {
    throw new LauncherError(`${INIT_CONFIG} needs at least one root`);
  }

  const roots = args.map((root) => storedRoot(deps, root));
  const { stateDir, userConfigFile } = pathsOf(deps);

  sharedRootsOf({ roots }, { home: deps.home, agentDir: hostAgentDirOf(deps), stateDir });

  const existing = await readJsonFile<unknown>(userConfigFile);

  if (existing === undefined) {
    await writeJsonFile(userConfigFile, { workspaceRoots: { roots } }, { mode: CONFIG_MODE });

    return 0;
  }

  if (isDeepStrictEqual(rootsIn(existing), roots)) {
    return 0;
  }

  throw new LauncherError(`${userConfigFile} exists; set workspaceRoots in it, or install without --root`);
};
