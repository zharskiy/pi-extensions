import { realpathSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const PI_AGENT_DIR_VARIABLE = "PI_CODING_AGENT_DIR";

interface LauncherPaths {
  stateDir: string;
  userConfigFile: string;
}

interface PathContext {
  env: NodeJS.ProcessEnv;
  home: string;
}

const APP = "pi-sandbox";

const BUILD_DIR = "dist";

const STATE_DIR = "state";

const CONFIG_FILE = "config.json";

const FILE_URL = /^file:\/\//;

const present = (value: string | undefined) => (value === undefined || value === "" ? undefined : value);

export const expandHome = (path: string, home = homedir()) => {
  if (path === "~") {
    return home;
  }

  return path.startsWith("~/") ? join(home, path.slice(2)) : path;
};

export const hostAgentDir = (home: string, env: NodeJS.ProcessEnv) => {
  const configured = env[PI_AGENT_DIR_VARIABLE];

  if (typeof configured !== "string" || configured === "") {
    return join(home, ".pi", "agent");
  }

  const expanded = expandHome(configured, home);

  return FILE_URL.test(expanded) ? fileURLToPath(expanded) : expanded;
};

const launcherDir = (home: string, env: NodeJS.ProcessEnv) => join(hostAgentDir(home, env), APP);

export const launcherPaths = (context: Partial<PathContext> = {}): LauncherPaths => {
  const env = context.env ?? process.env;
  const home = context.home ?? homedir();

  return {
    stateDir: present(env.PI_SANDBOX_STATE_DIR) ?? join(launcherDir(home, env), STATE_DIR),
    userConfigFile: present(env.PI_SANDBOX_USER_CONFIG) ?? join(launcherDir(home, env), CONFIG_FILE),
  };
};

export const isWithin = (path: string, parent: string) => {
  const rest = relative(parent, path);

  return rest === "" || (rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest));
};

export const realOrResolved = async (path: string) => {
  const absolute = resolve(path);

  return realpath(absolute).catch(() => absolute);
};

export const realOrResolvedSync = (path: string) => {
  const absolute = resolve(path);

  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
};

const moduleFolder = (moduleUrl: string) => dirname(dirname(fileURLToPath(moduleUrl)));

const isCompiled = (moduleUrl = import.meta.url) => basename(moduleFolder(moduleUrl)) === BUILD_DIR;

export const launcherRoot = (moduleUrl = import.meta.url) => {
  const folder = moduleFolder(moduleUrl);

  return isCompiled(moduleUrl) ? dirname(folder) : folder;
};

export const launcherEntry = (relativeTsPath: string, moduleUrl = import.meta.url) =>
  isCompiled(moduleUrl)
    ? join(launcherRoot(moduleUrl), BUILD_DIR, relativeTsPath.replace(/\.ts$/, ".js"))
    : join(launcherRoot(moduleUrl), relativeTsPath);
