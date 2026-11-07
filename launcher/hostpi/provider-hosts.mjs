import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const AI_PACKAGE = join("@earendil-works", "pi-ai");

const PROVIDERS_EXPORT = "./providers/*";

const PLAIN_HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

const packageDirFrom = (start) => {
  const candidate = join(start, "node_modules", AI_PACKAGE);

  if (existsSync(join(candidate, "package.json"))) {
    return candidate;
  }

  const parent = dirname(start);

  return parent === start ? undefined : packageDirFrom(parent);
};

const providersModule = (aiDir) => {
  const manifest = JSON.parse(readFileSync(join(aiDir, "package.json"), "utf8"));
  const target = manifest.exports?.[PROVIDERS_EXPORT]?.import;

  if (typeof target !== "string") {
    throw new Error(`${aiDir}: no ${PROVIDERS_EXPORT} export`);
  }

  return pathToFileURL(join(aiDir, target.replace("*", "all"))).href;
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
  const aiDir = packageDirFrom(piPackageDir);

  if (aiDir === undefined) {
    throw new Error(`${piPackageDir}: ${AI_PACKAGE} not found`);
  }

  const providers = await import(providersModule(aiDir));
  const ids = [...providers.getBuiltinProviders()].sort();
  const table = Object.fromEntries(ids.map((id) => [id, { hosts: hostsOf(providers, id) }]));

  process.stdout.write(`${JSON.stringify(table)}\n`);
};

main(process.argv[2] ?? process.cwd()).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);

  process.exitCode = 1;
});
