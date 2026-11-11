import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const AI_PACKAGE = join("@earendil-works", "pi-ai");

const PROVIDERS_EXPORT = "./providers/*";

const ENV_KEYS_FILE = "env-api-keys.js";

const PLAIN_HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

const installRoot = (dir) => {
  const parent = dirname(dir);

  if (parent === dir) {
    return undefined;
  }

  return basename(dir) === "node_modules" ? parent : installRoot(parent);
};

const declaresWorkspaces = (dir) => {
  try {
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).workspaces !== undefined;
  } catch {
    return false;
  }
};

const workspaceRoot = (dir) => {
  if (declaresWorkspaces(dir)) {
    return dir;
  }

  const parent = dirname(dir);

  return parent === dir ? undefined : workspaceRoot(parent);
};

const packageDirFrom = (start, stop) => {
  const candidate = join(start, "node_modules", AI_PACKAGE);

  if (existsSync(join(candidate, "package.json"))) {
    return candidate;
  }

  const parent = dirname(start);

  return start === stop || parent === start ? undefined : packageDirFrom(parent, stop);
};

const providersTarget = (aiDir) => {
  const manifest = JSON.parse(readFileSync(join(aiDir, "package.json"), "utf8"));
  const target = manifest.exports?.[PROVIDERS_EXPORT]?.import;

  if (typeof target !== "string") {
    throw new Error(`${aiDir}: no ${PROVIDERS_EXPORT} export`);
  }

  return join(aiDir, target.replace("*", "all"));
};

const EVERY_VARIABLE_SET = new Proxy({}, { get: () => "set" });

const envKeysFinder = async (providersFile) => {
  const file = join(dirname(dirname(providersFile)), ENV_KEYS_FILE);

  if (!existsSync(file)) {
    return () => undefined;
  }

  const { findEnvKeys } = await import(pathToFileURL(file).href);

  return typeof findEnvKeys === "function" ? (id) => findEnvKeys(id, EVERY_VARIABLE_SET) : () => undefined;
};

const entryOf = (providers, envKeys, id) => {
  const envVars = envKeys(id);

  return Array.isArray(envVars) && envVars.length > 0
    ? { hosts: hostsOf(providers, id), envVars }
    : { hosts: hostsOf(providers, id) };
};

const hostOf = (baseUrl) => {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();

    return PLAIN_HOST.test(host) ? host : "";
  } catch {
    return "";
  }
};

const hostsOf = (providers, id) => {
  const hosts = providers
    .getBuiltinModels(id)
    .map((model) => hostOf(model.baseUrl))
    .filter((host) => host !== "");

  return [...new Set(hosts)].sort();
};

const main = async (piPackageDir) => {
  const aiDir = packageDirFrom(
    piPackageDir,
    installRoot(piPackageDir) ?? workspaceRoot(piPackageDir) ?? piPackageDir,
  );

  if (aiDir === undefined) {
    throw new Error(`${piPackageDir}: ${AI_PACKAGE} not found`);
  }

  const providersFile = providersTarget(aiDir);
  const providers = await import(pathToFileURL(providersFile).href);
  const envKeys = await envKeysFinder(providersFile);
  const ids = [...providers.getBuiltinProviders()].sort();
  const table = Object.fromEntries(ids.map((id) => [id, entryOf(providers, envKeys, id)]));

  process.stdout.write(`${JSON.stringify(table)}\n`);
};

main(process.argv[2] ?? process.cwd()).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);

  process.exitCode = 1;
});
