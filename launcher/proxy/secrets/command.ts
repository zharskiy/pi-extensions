import type { CommandRunner } from "../../shared/index.ts";
import type { CachedSecret } from "./cache.ts";
import { unavailable } from "./errors.ts";

const DEFAULT_TTL_SECONDS = 300;

const SECONDS_THRESHOLD = 1e12;

const EXPIRY_SKEW_MS = 30_000;

const COMMAND_TIMEOUT_MS = 30_000;

const expiryOf = (value: unknown) => {
  if (typeof value === "number") {
    return value < SECONDS_THRESHOLD ? value * 1000 : value;
  }

  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;

  return Number.isNaN(parsed) ? undefined : parsed;
};

const usableUntil = (expiresAt: number | undefined) =>
  expiresAt === undefined ? undefined : expiresAt - EXPIRY_SKEW_MS;

const parseJson = (text: string) => {
  try {
    return JSON.parse(text) as { token?: unknown; expiresAt?: unknown };
  } catch {
    return undefined;
  }
};

const parseOutput = (stdout: string) => {
  const text = stdout.trim();

  if (!text.startsWith("{")) {
    return { token: text, expiresAt: undefined };
  }

  const parsed = parseJson(text);

  return {
    token: typeof parsed?.token === "string" ? parsed.token.trim() : "",
    expiresAt: usableUntil(expiryOf(parsed?.expiresAt)),
  };
};

export interface CommandSecretInput {
  key: string;
  kind: string;
  argv: string[];
  ttlSeconds?: number;
  runner: CommandRunner;
  now: () => number;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export const commandSecret = async (input: CommandSecretInput): Promise<CachedSecret> => {
  const [file, ...args] = input.argv;

  if (file === undefined || file === "") {
    throw unavailable(`${input.kind} secret for ${input.key}: no command`);
  }

  const timeoutMs = input.timeoutMs ?? COMMAND_TIMEOUT_MS;
  const result = await input.runner
    .run(file, args, { timeoutMs, ...(input.env === undefined ? {} : { env: input.env }) })
    .catch(() => undefined);

  if (result === undefined) {
    throw unavailable(`${input.kind} secret for ${input.key}: ${file} could not be started`);
  }

  if (result.timedOut === true) {
    throw unavailable(`${input.kind} secret for ${input.key}: ${file} timed out after ${timeoutMs / 1000} s`);
  }

  if (result.code !== 0) {
    throw unavailable(`${input.kind} secret for ${input.key}: ${file} exited with ${result.code}`);
  }

  const output = parseOutput(result.stdout);

  if (output.token === "") {
    throw unavailable(`${input.kind} secret for ${input.key}: ${file} printed no token`);
  }

  return {
    value: output.token,
    expiresAt: output.expiresAt ?? input.now() + (input.ttlSeconds ?? DEFAULT_TTL_SECONDS) * 1000,
  };
};
