import { posix } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { type Backend, execCapture } from "../backend/index.ts";
import type { ContainerMcpAuthEntries } from "../hostpi/index.ts";
import {
  CONTAINER_MCP_AUTH_LOCK,
  GUEST_PATHS,
  isJsonObject,
  isPlaceholder,
  type JsonObject,
  LauncherError,
  parseJsonObject,
  stableHash,
  stateLayout,
  writeJsonFile,
} from "../shared/index.ts";
import type { ContainerMcpAuthSyncInput, SyncResult } from "./types.ts";

const FILE = posix.join(GUEST_PATHS.agentDir, "mcp-auth.json");

const LOCK = posix.join(GUEST_PATHS.agentDir, CONTAINER_MCP_AUTH_LOCK);

const LOCK_STALE_MS = 10_000;

const LOCK_TIMEOUT_MS = LOCK_STALE_MS + 5_000;

const LOCK_RETRY_MS = 50;

const LOCK_REFRESH_MS = 1_000;

const LOCK_BUSY = 3;

const PRIVATE_MODE = 0o600;

const SECRET_TOKEN_FIELDS = ["access_token", "refresh_token", "id_token"] as const;

const READ_FAILED = 4;

const LOCK_AND_READ_SCRIPT = [
  'const fs = require("node:fs");',
  "const [lock, staleMs, file] = [process.argv[1], Number(process.argv[2]), process.argv[3]];",
  'fs.mkdirSync(require("node:path").dirname(lock), { recursive: true });',
  "const take = () => { try { fs.mkdirSync(lock); return true; } catch (error) { if (error.code !== 'EEXIST') throw error; return false; } };",
  "const look = (path) => { try { return fs.statSync(path); } catch { return undefined; } };",
  "const same = (left, right) => left !== undefined && left.ino === right.ino && left.mtimeMs === right.mtimeMs;",
  'const aside = lock + ".stale." + process.pid + "." + Date.now();',
  "const drop = () => fs.rmSync(aside, { recursive: true, force: true });",
  "const settle = (seen) => same(look(aside), seen) || look(lock) !== undefined ? drop() : fs.renameSync(aside, lock);",
  "const moveAside = (seen) => { try { fs.renameSync(lock, aside); } catch { return; } settle(seen); };",
  "const stale = () => { const seen = look(lock); if (seen !== undefined && Date.now() - seen.mtimeMs <= staleMs) return false; if (seen !== undefined) moveAside(seen); return true; };",
  "const entry = () => { try { return fs.lstatSync(file); } catch { return undefined; } };",
  "const show = () => { const found = entry(); if (found?.isSymbolicLink()) { fs.rmSync(file, { force: true }); return; } if (found?.isFile()) { try { fs.chmodSync(file, 0o600); } catch {} fs.writeSync(1, fs.readFileSync(file)); } };",
  `const read = () => { try { show(); return 0; } catch { fs.rmSync(lock, { recursive: true, force: true }); return ${READ_FAILED}; } };`,
  `process.exitCode = take() || (stale() && take()) ? read() : ${LOCK_BUSY};`,
].join("\n");

const WRITE_SCRIPT =
  'umask 077 && rm -f "$1.pi-sandbox-tmp" && cat > "$1.pi-sandbox-tmp" && mv -f "$1.pi-sandbox-tmp" "$1"';

const run = (backend: Backend, containerId: string, command: string[], stdin?: string) =>
  execCapture(backend, { containerId, command, env: {}, workdir: "/" }, stdin);

const script = (text: string, ...args: string[]) => ["sh", "-c", text, "sh", ...args];

const lockAndReadCommand = () =>
  script('exec node -e "$1" "$2" "$3" "$4"', LOCK_AND_READ_SCRIPT, LOCK, String(LOCK_STALE_MS), FILE);

const acquireAndRead = async (backend: Backend, containerId: string, deadline: number): Promise<string> => {
  const attempt = await run(backend, containerId, lockAndReadCommand());

  if (attempt.code === 0) {
    return attempt.stdout;
  }

  if (attempt.code === READ_FAILED) {
    throw new LauncherError("mcp-auth.json: could not read it in the sandbox");
  }

  if (attempt.code !== LOCK_BUSY) {
    throw new LauncherError(`mcp-auth.json: could not lock it in the sandbox (exit ${attempt.code})`);
  }

  if (Date.now() >= deadline) {
    throw new LauncherError(
      "mcp-auth.json: the lock in the sandbox is held by another process",
      "try again in a moment",
    );
  }

  await sleep(LOCK_RETRY_MS);

  return acquireAndRead(backend, containerId, deadline);
};

const keepFresh = (backend: Backend, containerId: string) =>
  setInterval(() => {
    void run(backend, containerId, script('touch -c "$1"', LOCK)).catch(() => undefined);
  }, LOCK_REFRESH_MS);

const parseFile = (text: string): { value: JsonObject; invalid: boolean } => {
  if (text.trim() === "") {
    return { value: {}, invalid: false };
  }

  const value = parseJsonObject(text);

  return value === undefined ? { value: {}, invalid: true } : { value, invalid: false };
};

const withoutTokens = (value: unknown): JsonObject => {
  if (!isJsonObject(value)) {
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

const isClientSecretField = (field: string) => field.toLowerCase().startsWith("client_secret");

const vaultClientSecret = (entry: ContainerMcpAuthEntries[string] | undefined) => {
  const client = isJsonObject(entry) && isJsonObject(entry.clientInformation) ? entry.clientInformation : {};

  return client.client_secret;
};

const sweptClient = (entry: JsonObject, vaultSecret: unknown) => {
  if (!isJsonObject(entry.clientInformation)) {
    return { entry, swept: false };
  }

  const client = entry.clientInformation;
  const leaked = Object.keys(client).filter(
    (field) =>
      isClientSecretField(field) && typeof client[field] === "string" && client[field] !== vaultSecret,
  );

  if (leaked.length === 0) {
    return { entry, swept: false };
  }

  const kept = Object.fromEntries(Object.entries(client).filter(([field]) => !leaked.includes(field)));

  return { entry: { ...entry, clientInformation: kept }, swept: true };
};

const sweptEntry = (entry: unknown, vaultSecret: unknown) => {
  if (!isJsonObject(entry)) {
    return { entry, swept: false };
  }

  const client = sweptClient(entry, vaultSecret);
  const tokens = sweptTokens(client.entry);

  return { entry: tokens.entry, swept: client.swept || tokens.swept };
};

const sweptTokens = (entry: JsonObject) => {
  if (!isJsonObject(entry.tokens)) {
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

const sweep = (value: JsonObject, entries: ContainerMcpAuthEntries) => {
  const results = Object.entries(value).map(([key, entry]) => ({
    key,
    ...sweptEntry(entry, vaultClientSecret(entries[key])),
  }));

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

const mergeAndWrite = async (input: ContainerMcpAuthSyncInput, text: string): Promise<SyncResult> => {
  const current = parseFile(text);
  const swept = sweep(applyEntries(current.value, input.entries), input.entries);
  const unchanged =
    !current.invalid && text.trim() !== "" && stableHash(swept.value) === stableHash(current.value);

  if (!unchanged) {
    const written = await run(
      input.backend,
      input.containerId,
      script(WRITE_SCRIPT, FILE),
      `${JSON.stringify(swept.value, null, 2)}\n`,
    );

    if (written.code !== 0) {
      throw new LauncherError(`mcp-auth.json: could not write it into the sandbox (exit ${written.code})`);
    }
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
  const text = await acquireAndRead(input.backend, input.containerId, Date.now() + LOCK_TIMEOUT_MS);
  const refresher = keepFresh(input.backend, input.containerId);

  try {
    return await mergeAndWrite(input, text);
  } finally {
    clearInterval(refresher);

    await run(input.backend, input.containerId, script('rm -rf "$1"', LOCK)).catch(() => undefined);
  }
};
