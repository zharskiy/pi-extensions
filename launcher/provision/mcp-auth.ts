import { posix } from "node:path";
import { Readable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import type { Backend } from "../backend/index.ts";
import type { ContainerMcpAuthEntries, JsonObject } from "../hostpi/index.ts";
import {
  CONTAINER_MCP_AUTH_LOCK,
  GUEST_PATHS,
  isPlaceholder,
  LauncherError,
  stateLayout,
  writeJsonFile,
} from "../shared/index.ts";
import type { ContainerMcpAuthSyncInput, SyncResult } from "./types.ts";
import { collector } from "./volume.ts";

const FILE = posix.join(GUEST_PATHS.agentDir, "mcp-auth.json");

const LOCK = posix.join(GUEST_PATHS.agentDir, CONTAINER_MCP_AUTH_LOCK);

const LOCK_TIMEOUT_MS = 5_000;

const LOCK_RETRY_MS = 50;

const PRIVATE_MODE = 0o600;

const SECRET_TOKEN_FIELDS = ["access_token", "refresh_token", "id_token"] as const;

const LOCK_SCRIPT = 'mkdir -p "$(dirname "$1")" && mkdir "$1" 2>/dev/null';

const TAKE_OVER_SCRIPT = 'rm -rf "$1" && mkdir "$1"';

const READ_SCRIPT = 'if [ -L "$1" ]; then rm -f "$1"; fi; if [ -f "$1" ]; then cat "$1"; fi';

const WRITE_SCRIPT =
  'umask 077 && rm -f "$1.pi-sandbox-tmp" && cat > "$1.pi-sandbox-tmp" && mv -f "$1.pi-sandbox-tmp" "$1"';

interface ExecResult {
  code: number;
  stdout: string;
}

const run = async (backend: Backend, containerId: string, command: string[], stdin?: string) => {
  const stdout = collector();
  const code = await backend.exec(
    { containerId, command, env: {}, workdir: "/" },
    {
      ...(stdin === undefined ? {} : { stdin: Readable.from([Buffer.from(stdin)]) }),
      stdout: stdout.stream,
      stderr: collector().stream,
      tty: false,
    },
  );

  return { code, stdout: stdout.text() } satisfies ExecResult;
};

const script = (text: string, path: string) => ["sh", "-c", text, "sh", path];

const acquire = async (backend: Backend, containerId: string, deadline: number): Promise<void> => {
  const attempt = await run(backend, containerId, script(LOCK_SCRIPT, LOCK));

  if (attempt.code === 0) {
    return;
  }

  if (Date.now() < deadline) {
    await sleep(LOCK_RETRY_MS);

    return acquire(backend, containerId, deadline);
  }

  const taken = await run(backend, containerId, script(TAKE_OVER_SCRIPT, LOCK));

  if (taken.code !== 0) {
    throw new LauncherError(`mcp-auth.json: could not lock it in the sandbox (exit ${taken.code})`);
  }
};

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseFile = (text: string): { value: JsonObject; invalid: boolean } => {
  if (text.trim() === "") {
    return { value: {}, invalid: false };
  }

  try {
    const value: unknown = JSON.parse(text);

    return isObject(value) ? { value, invalid: false } : { value: {}, invalid: true };
  } catch {
    return { value: {}, invalid: true };
  }
};

const withoutTokens = (value: unknown): JsonObject => {
  if (!isObject(value)) {
    return {};
  }

  const { tokens: _tokens, tokensExpireAt: _expiry, ...rest } = value;

  return rest;
};

const withoutExpiry = ({ tokensExpireAt: _expiry, ...rest }: JsonObject) => rest;

const applyEntries = (current: JsonObject, entries: ContainerMcpAuthEntries): JsonObject => {
  const updated = Object.entries(entries).map(([key, entry]): [string, JsonObject | undefined] => [
    key,
    entry === null ? undefined : { ...withoutTokens(current[key]), ...withoutExpiry(entry) },
  ]);
  const next: Record<string, unknown> = { ...current, ...Object.fromEntries(updated) };

  return Object.fromEntries(Object.entries(next).filter(([, value]) => value !== undefined));
};

const isLeak = (value: unknown) => typeof value === "string" && !isPlaceholder(value);

const sweptEntry = (entry: unknown) => {
  if (!isObject(entry) || !isObject(entry.tokens)) {
    return { entry, swept: false };
  }

  const tokens = entry.tokens;
  const leaked = SECRET_TOKEN_FIELDS.filter((field) => isLeak(tokens[field]));

  if (leaked.length === 0) {
    return { entry, swept: false };
  }

  const kept = Object.fromEntries(
    Object.entries(tokens).filter(([field]) => !(leaked as readonly string[]).includes(field)),
  );

  return {
    entry: typeof kept.access_token === "string" ? { ...entry, tokens: kept } : withoutTokens(entry),
    swept: true,
  };
};

const sweep = (value: JsonObject) => {
  const results = Object.entries(value).map(([key, entry]) => ({ key, ...sweptEntry(entry) }));

  return {
    value: Object.fromEntries(results.map((result) => [result.key, result.entry])),
    notices: results
      .filter((result) => result.swept)
      .map(
        (result) =>
          `mcp: removed a token that is not a placeholder from the sandbox's mcp-auth.json (${result.key})`,
      ),
  };
};

const mergeAndWrite = async (input: ContainerMcpAuthSyncInput): Promise<SyncResult> => {
  const read = await run(input.backend, input.containerId, script(READ_SCRIPT, FILE));

  if (read.code !== 0) {
    throw new LauncherError(`mcp-auth.json: could not read it in the sandbox (exit ${read.code})`);
  }

  const current = parseFile(read.stdout);
  const swept = sweep(applyEntries(current.value, input.entries));
  const text = `${JSON.stringify(swept.value, null, 2)}\n`;
  const written = await run(input.backend, input.containerId, script(WRITE_SCRIPT, FILE), text);

  if (written.code !== 0) {
    throw new LauncherError(`mcp-auth.json: could not write it into the sandbox (exit ${written.code})`);
  }

  await writeJsonFile(stateLayout(input.stateDir).syncMcpAuth(input.repoHash), swept.value, {
    mode: PRIVATE_MODE,
  });

  const invalid = current.invalid
    ? ["mcp-auth.json in the sandbox volume was not valid JSON; replaced with the vault entries"]
    : [];

  return { notices: [...invalid, ...swept.notices] };
};

export const syncContainerMcpAuth = async (input: ContainerMcpAuthSyncInput): Promise<SyncResult> => {
  await acquire(input.backend, input.containerId, Date.now() + LOCK_TIMEOUT_MS);

  try {
    return await mergeAndWrite(input);
  } finally {
    await run(input.backend, input.containerId, ["rm", "-rf", LOCK]).catch(() => undefined);
  }
};
