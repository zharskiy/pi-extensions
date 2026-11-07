import {
  type CommandRunner,
  errorMessage,
  parseJsonObject,
  readJsonObject,
  stateLayout,
  type VaultDiscovery,
  type VaultServer,
  writeJsonFile,
} from "../../shared/index.ts";
import { singleFlight } from "../single-flight.ts";

export interface DiscoveryOptions {
  stateDir: string;
  runner: CommandRunner;
  command?: string[];
  now: () => number;
}

export type DiscoverFn = (server: VaultServer) => Promise<VaultDiscovery>;

const FAILURE_TTL_MS = 60_000;

const PRIVATE_MODE = 0o600;

const isText = (value: unknown) => typeof value === "string" && value !== "";

const isDiscovered = (value: Record<string, unknown>) =>
  value.ok === true &&
  isText(value.issuer) &&
  isText(value.authorizationEndpoint) &&
  isText(value.tokenEndpoint) &&
  Array.isArray(value.hosts) &&
  value.hosts.every((host) => typeof host === "string");

const parseRecord = (parsed: Record<string, unknown> | undefined): VaultDiscovery | undefined => {
  if (parsed === undefined || typeof parsed.fetchedAt !== "number") {
    return undefined;
  }

  return isDiscovered(parsed) || (parsed.ok === false && typeof parsed.error === "string")
    ? (parsed as unknown as VaultDiscovery)
    : undefined;
};

const failed = (server: VaultServer, error: string, fetchedAt: number): VaultDiscovery => ({
  ok: false,
  server: server.server,
  url: server.url,
  error,
  fetchedAt,
});

const commandInput = (server: VaultServer) => {
  const metadataUrl = server.oauth?.authServerMetadataUrl;

  return JSON.stringify({
    url: server.url,
    ...(typeof metadataUrl === "string" ? { authServerMetadataUrl: metadataUrl } : {}),
  });
};

const fromOutput = (server: VaultServer, stdout: string, fetchedAt: number): VaultDiscovery => {
  const parsed = parseJsonObject(stdout);

  if (parsed !== undefined && isDiscovered(parsed)) {
    return { ...(parsed as unknown as VaultDiscovery), server: server.server, url: server.url, fetchedAt };
  }

  return failed(server, typeof parsed?.error === "string" ? parsed.error : "unexpected output", fetchedAt);
};

export const createDiscovery = (options: DiscoveryOptions): DiscoverFn => {
  const layout = stateLayout(options.stateDir);
  const flight = singleFlight<string, VaultDiscovery>();

  const run = async (server: VaultServer, command: string[]) => {
    const [file = "", ...args] = command;
    const result = await options.runner
      .run(file, args, { input: commandInput(server) })
      .catch((error: unknown) => ({ code: 1, stdout: "", stderr: errorMessage(error) }));
    const fetchedAt = options.now();
    const record =
      result.code === 0
        ? fromOutput(server, result.stdout, fetchedAt)
        : failed(server, result.stderr.trim().split("\n").at(-1) || `exit code ${result.code}`, fetchedAt);

    await writeJsonFile(layout.mcpAuthDiscovery(server.server), record, { mode: PRIVATE_MODE });

    return record;
  };

  const rediscover = (server: VaultServer, command: string[]) =>
    flight(server.server, () => run(server, command));

  return async (server) => {
    const cached = parseRecord(await readJsonObject(layout.mcpAuthDiscovery(server.server)));
    const current = cached?.url === server.url ? cached : undefined;
    const usable =
      current?.ok === true || (current !== undefined && options.now() - current.fetchedAt < FAILURE_TTL_MS);

    if (current !== undefined && usable) {
      return current;
    }

    if (options.command === undefined || options.command.length === 0) {
      return current ?? server.discovery;
    }

    return rediscover(server, options.command);
  };
};
