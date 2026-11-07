import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type CommandRunner,
  errorMessage,
  isJsonObject,
  launcherRoot,
  parseJsonObject,
  readJsonObject,
  stateLayout,
  writeJsonFile,
} from "../shared/index.ts";
import type { BundledPi, ProviderHosts } from "./types.ts";

export interface ProviderHostsInput {
  stateDir: string;
  runner: CommandRunner;
  pi: BundledPi;
  imagePiVersion: string;
}

export interface ProviderHostsResult {
  hosts: ProviderHosts;
  notices: string[];
}

interface PiManifest {
  version?: unknown;
  bin?: unknown;
}

const PI_PACKAGE = "@earendil-works/pi-coding-agent";

const PI_BIN = "pi";

const SCRIPT = "provider-hosts.mjs";

const SAFE_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/;

const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const isTable = (value: unknown): value is ProviderHosts =>
  isJsonObject(value) &&
  Object.values(value).every(
    (entry) =>
      isJsonObject(entry) &&
      isStringList(entry.hosts) &&
      (entry.envVars === undefined || isStringList(entry.envVars)),
  );

const parseTable = (text: string) => {
  const value = parseJsonObject(text);

  return isTable(value) ? value : undefined;
};

const packageDirFrom = (start: string): string | undefined => {
  const candidate = join(start, "node_modules", PI_PACKAGE);

  if (existsSync(join(candidate, "package.json"))) {
    return candidate;
  }

  const parent = dirname(start);

  return parent === start ? undefined : packageDirFrom(parent);
};

const binOf = (manifest: PiManifest) => {
  if (typeof manifest.bin === "string") {
    return manifest.bin;
  }

  const named = isJsonObject(manifest.bin) ? manifest.bin[PI_BIN] : undefined;

  return typeof named === "string" ? named : undefined;
};

export const locateBundledPi = async (): Promise<BundledPi | undefined> => {
  const packageDir = packageDirFrom(launcherRoot());

  if (packageDir === undefined) {
    return undefined;
  }

  const manifest: PiManifest = (await readJsonObject(join(packageDir, "package.json"))) ?? {};
  const bin = binOf(manifest);

  if (typeof manifest.version !== "string" || bin === undefined) {
    return undefined;
  }

  return { command: [process.execPath, join(packageDir, bin)], version: manifest.version, packageDir };
};

const unavailable = (reason: string): ProviderHostsResult => ({
  hosts: {},
  notices: [`provider host table unavailable (${reason}); built-in providers get no credential rules`],
});

const cachedTable = async (path: string | undefined) => {
  const value = path === undefined ? undefined : await readJsonObject(path);

  return isTable(value) ? value : undefined;
};

const runScript = async (
  input: ProviderHostsInput,
  cache: string | undefined,
): Promise<ProviderHostsResult> => {
  const script = join(launcherRoot(), "hostpi", SCRIPT);
  const result = await input.runner
    .run(process.execPath, [script, input.pi.packageDir])
    .catch((error: unknown) => ({ code: 1, stdout: "", stderr: errorMessage(error) }));
  const table = result.code === 0 ? parseTable(result.stdout) : undefined;

  if (table === undefined) {
    return unavailable(
      result.code === 0 ? "unreadable output" : result.stderr.trim() || `exit ${result.code}`,
    );
  }

  if (cache !== undefined) {
    await writeJsonFile(cache, table);
  }

  return { hosts: table, notices: [] };
};

export const readProviderHosts = async (input: ProviderHostsInput): Promise<ProviderHostsResult> => {
  if (input.pi.version !== input.imagePiVersion) {
    return unavailable(
      `the launcher's pi ${input.pi.version} differs from the image pi ${input.imagePiVersion}`,
    );
  }

  const cache = SAFE_VERSION.test(input.pi.version)
    ? stateLayout(input.stateDir).providerHosts(input.pi.version)
    : undefined;
  const cached = await cachedTable(cache);

  return cached === undefined ? runScript(input, cache) : { hosts: cached, notices: [] };
};
