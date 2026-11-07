import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CommandRunner, writeFileAtomic } from "../../shared/index.ts";
import type { CachedSecret, SecretLoadOptions } from "./cache.ts";
import { unavailable } from "./errors.ts";

export interface McpOAuthDeps {
  runner: CommandRunner;
  now: () => number;
  piCommand: string[];
  mcpAuthDir: string;
}

interface TokenEntry {
  tokens?: { access_token?: unknown };
  tokensExpireAt?: unknown;
}

const REFRESH_MARGIN_MS = 60_000;

const SERVER_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

const PRIVATE_MODE = 0o600;

const readJson = async (path: string) => {
  const text = await readFile(path, "utf8").catch(() => undefined);

  try {
    return text === undefined ? undefined : (JSON.parse(text) as unknown);
  } catch {
    return undefined;
  }
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const authKey = (server: string, href: string) => `mcp__${server.replaceAll("-", "_")}|${href}`;

const storeEntry = (store: unknown, server: string, href: string) => {
  if (!isObject(store)) {
    return undefined;
  }

  const exact = authKey(server, href);
  const name = Object.hasOwn(store, exact)
    ? exact
    : Object.keys(store).find((key) => key.endsWith(`|${href}`));
  const entry = name === undefined ? undefined : store[name];

  return name !== undefined && isObject(entry) ? { name, entry: entry as TokenEntry } : undefined;
};

const usable = (entry: TokenEntry | undefined, now: number) => {
  const access = entry?.tokens?.access_token;
  const expiresAt = typeof entry?.tokensExpireAt === "number" ? entry.tokensExpireAt : undefined;

  if (typeof access !== "string" || access === "") {
    return undefined;
  }

  if (expiresAt !== undefined && expiresAt - REFRESH_MARGIN_MS <= now) {
    return undefined;
  }

  return { value: access, expiresAt: expiresAt === undefined ? undefined : expiresAt - REFRESH_MARGIN_MS };
};

const writePrivateJson = (path: string, value: unknown) =>
  writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`, { mode: PRIVATE_MODE });

const serverDefinition = async (deps: McpOAuthDeps, key: string, server: string) => {
  const definition = await readJson(join(deps.mcpAuthDir, "servers", `${server}.json`));

  if (!isObject(definition) || typeof definition.url !== "string") {
    throw unavailable(`mcpOAuth secret for ${key}: server ${server} has no stored sign-in definition`);
  }

  return { url: definition.url, oauth: definition.oauth };
};

const storePath = (directory: string) => join(directory, "mcp-auth.json");

const prepareOneServerDir = async (deps: McpOAuthDeps, key: string, server: string, href: string) => {
  const definition = await serverDefinition(deps, key, server);
  const found = storeEntry(await readJson(storePath(deps.mcpAuthDir)), server, href);

  if (found === undefined) {
    throw unavailable(`mcpOAuth secret for ${key}: ${server} is not signed in; run pi mcp login ${server}`);
  }

  const root = await mkdtemp(join(tmpdir(), "pi-sandbox-mcp-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "cwd");

  await mkdir(cwd, { recursive: true, mode: 0o700 });

  await writePrivateJson(join(agentDir, "mcp.json"), { mcpServers: { [server]: definition } });

  await writePrivateJson(storePath(agentDir), { [found.name]: found.entry });

  return { root, agentDir, cwd, name: found.name };
};

const copyBack = async (deps: McpOAuthDeps, agentDir: string, name: string) => {
  const refreshed = await readJson(storePath(agentDir));
  const entry = isObject(refreshed) ? refreshed[name] : undefined;

  if (!isObject(entry)) {
    return;
  }

  const current = await readJson(storePath(deps.mcpAuthDir));

  await writePrivateJson(storePath(deps.mcpAuthDir), {
    ...(isObject(current) ? current : {}),
    [name]: entry,
  });
};

const runRefresh = async (deps: McpOAuthDeps, key: string, server: string, href: string) => {
  const [file, ...args] = deps.piCommand;

  if (file === undefined) {
    throw unavailable(`mcpOAuth secret for ${key}: no pi command is configured`);
  }

  const prepared = await prepareOneServerDir(deps, key, server, href);

  try {
    await deps.runner
      .run(file, [...args, "mcp", "list"], {
        cwd: prepared.cwd,
        env: { PI_CODING_AGENT_DIR: prepared.agentDir },
      })
      .catch(() => undefined);

    await copyBack(deps, prepared.agentDir, prepared.name);
  } finally {
    await rm(prepared.root, { recursive: true, force: true });
  }
};

export const createMcpOAuthSource = (deps: McpOAuthDeps) => {
  const queue = { tail: Promise.resolve() };

  const serialised = (task: () => Promise<void>) => {
    const next = queue.tail.then(task, task);

    queue.tail = next.catch(() => undefined);

    return next;
  };

  const read = async (server: string, href: string) =>
    usable(storeEntry(await readJson(storePath(deps.mcpAuthDir)), server, href)?.entry, deps.now());

  return async (
    key: string,
    ref: { mcpOAuth: { server: string; url: string } },
    options: SecretLoadOptions,
  ): Promise<CachedSecret> => {
    const { server, url } = ref.mcpOAuth;

    if (!SERVER_NAME.test(server)) {
      throw unavailable(`mcpOAuth secret for ${key}: ${server} is not a valid server name`);
    }

    const href = new URL(url).href;
    const current = options.forced ? undefined : await read(server, href);

    if (current !== undefined) {
      return current;
    }

    await serialised(() => runRefresh(deps, key, server, href));

    const refreshed = await read(server, href);

    if (refreshed === undefined) {
      throw unavailable(
        `mcpOAuth secret for ${key}: no valid token for ${server}; run pi mcp login ${server}`,
      );
    }

    return refreshed;
  };
};
