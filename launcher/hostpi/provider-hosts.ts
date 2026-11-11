import { join } from "node:path";
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
import { SAFE_VERSION } from "./locate.ts";
import type { BundledPi, ProviderHosts } from "./types.ts";

export interface ProviderHostsInput {
  stateDir: string;
  runner: CommandRunner;
  pi: BundledPi;
}

export interface ProviderHostsResult {
  hosts: ProviderHosts;
  notices: string[];
}

const SCRIPT = "provider-hosts.mjs";

const SCRIPT_TIMEOUT_MS = 30_000;

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
    .run(process.execPath, [script, input.pi.packageDir], { timeoutMs: SCRIPT_TIMEOUT_MS })
    .catch((error: unknown) => ({ code: 1, stdout: "", stderr: errorMessage(error) }));

  if ("timedOut" in result && result.timedOut === true) {
    return unavailable(`no answer within ${SCRIPT_TIMEOUT_MS / 1000} s`);
  }

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
  const cache = SAFE_VERSION.test(input.pi.version)
    ? stateLayout(input.stateDir).providerHosts(input.pi.version)
    : undefined;
  const cached = await cachedTable(cache);

  return cached === undefined ? runScript(input, cache) : { hosts: cached, notices: [] };
};
