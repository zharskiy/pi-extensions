import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

interface LauncherPaths {
  stateDir: string;
  userConfigFile: string;
  policyFile: string;
}

interface PathContext {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  home: string;
  fileExists: (path: string) => boolean;
}

const APP = "pi-sandbox";

const BUILD_DIR = "dist";

const MACOS_POLICY_FILE = join("/Library/Application Support", APP, "policy.json");

const LINUX_POLICY_FILE = join("/etc", APP, "policy.json");

const defaultPolicyFile = (platform: NodeJS.Platform) =>
  platform === "darwin" ? MACOS_POLICY_FILE : LINUX_POLICY_FILE;

const present = (value: string | undefined) => (value === undefined || value === "" ? undefined : value);

const policyFileOf = (context: Partial<PathContext>, env: NodeJS.ProcessEnv) => {
  const standard = defaultPolicyFile(context.platform ?? process.platform);
  const exists = context.fileExists ?? existsSync;

  return exists(standard) ? standard : (present(env.PI_SANDBOX_POLICY_FILE) ?? standard);
};

export const launcherPaths = (context: Partial<PathContext> = {}): LauncherPaths => {
  const env = context.env ?? process.env;
  const home = context.home ?? homedir();

  return {
    stateDir: present(env.PI_SANDBOX_STATE_DIR) ?? join(home, ".local", "state", APP),
    userConfigFile: present(env.PI_SANDBOX_USER_CONFIG) ?? join(home, ".config", APP, "config.json"),
    policyFile: policyFileOf(context, env),
  };
};

export const expandHome = (path: string, home = homedir()) => {
  if (path === "~") {
    return home;
  }

  return path.startsWith("~/") ? join(home, path.slice(2)) : path;
};

export const isWithin = (path: string, parent: string) => {
  const rest = relative(parent, path);

  return rest === "" || (rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest));
};

export const projectConfigFile = (repoRoot: string) => join(repoRoot, ".pi", "sandbox.json");

const moduleFolder = (moduleUrl: string) => dirname(dirname(fileURLToPath(moduleUrl)));

const isCompiled = (moduleUrl: string) => basename(moduleFolder(moduleUrl)) === BUILD_DIR;

export const launcherRoot = (moduleUrl = import.meta.url) => {
  const folder = moduleFolder(moduleUrl);

  return isCompiled(moduleUrl) ? dirname(folder) : folder;
};

export const launcherEntry = (relativeTsPath: string, moduleUrl = import.meta.url) =>
  isCompiled(moduleUrl)
    ? join(launcherRoot(moduleUrl), BUILD_DIR, relativeTsPath.replace(/\.ts$/, ".js"))
    : join(launcherRoot(moduleUrl), relativeTsPath);
