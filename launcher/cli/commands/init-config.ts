import { isAbsolute, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isJsonObject, LauncherError, readJsonFile, writeNewFile } from "../../shared/index.ts";
import { sharedRootsOf } from "../../workspace/index.ts";
import { type CliDeps, pathsOf } from "../deps.ts";

export const INIT_CONFIG = "__init-config";

const CONFIG_MODE = 0o600;

const isHomeForm = (root: string) => root === "~" || root.startsWith("~/");

const storedRoot = (deps: CliDeps, root: string) =>
  isAbsolute(root) || isHomeForm(root) ? root : resolve(deps.cwd, root);

const rootsIn = (config: unknown) => {
  const workspaceRoots = isJsonObject(config) ? config.workspaceRoots : undefined;
  const roots = isJsonObject(workspaceRoots) ? workspaceRoots.roots : undefined;

  return Array.isArray(roots) && roots.every((root) => typeof root === "string") ? roots : undefined;
};

const sharedSet = (deps: CliDeps, roots: string[]) => {
  const shared = sharedRootsOf({ roots }, { home: deps.home, env: deps.env });

  return [...new Set([...shared.roots, ...shared.missing])].sort();
};

const existsError = (userConfigFile: string) =>
  new LauncherError(`${userConfigFile} exists; set workspaceRoots in it, or install without --root`);

export const initConfigCommand = async (deps: CliDeps, args: string[]) => {
  if (args.length === 0) {
    throw new LauncherError(`${INIT_CONFIG} needs at least one root`);
  }

  const roots = args.map((root) => storedRoot(deps, root));
  const { userConfigFile } = pathsOf(deps);
  const wanted = sharedSet(deps, roots);
  const text = `${JSON.stringify({ workspaceRoots: { roots } }, null, 2)}\n`;

  if (await writeNewFile(userConfigFile, text, { mode: CONFIG_MODE })) {
    return 0;
  }

  const existing = rootsIn(await readJsonFile<unknown>(userConfigFile));

  if (existing !== undefined && isDeepStrictEqual(sharedSet(deps, existing), wanted)) {
    return 0;
  }

  throw existsError(userConfigFile);
};
