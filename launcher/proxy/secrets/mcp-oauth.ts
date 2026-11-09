import { setTimeout as delay } from "node:timers/promises";
import {
  isFreshMcpToken,
  MCP_SERVER_NAME,
  MCP_TOKEN_SKEW_MS,
  type McpAuthEntry,
  mcpAuthKey,
  readMcpAuthEntry,
} from "../../shared/index.ts";
import type { SignIn } from "../sign-in.ts";
import type { CachedSecret } from "./cache.ts";
import { type SecretReply, signInReply, unavailable } from "./errors.ts";

export interface McpOAuthDeps {
  now: () => number;
  hostAgentDir: string;
  signIn: SignIn;
  signInWaitMs?: number;
}

type McpOAuthRef = { mcpOAuth: { server: string; url: string } };

const SIGN_IN_WAIT_MS = 10_000;

const replyFor = (server: string): SecretReply => ({
  status: 503,
  headers: { "retry-after": "30", "content-type": "text/plain" },
  body: `pi-sandbox: sign-in to MCP server ${server} opened in the browser on the host; finish it there, then retry. If no browser opened, run pi mcp login ${server} on the host.`,
});

const cachedOf = (entry: McpAuthEntry & { access: string }): CachedSecret => ({
  value: entry.access,
  expiresAt: entry.expiresAt === undefined ? undefined : entry.expiresAt - MCP_TOKEN_SKEW_MS,
});

const within = async (exited: Promise<number>, waitMs: number) => {
  const abort = new AbortController();
  const late = delay(waitMs, undefined, { signal: abort.signal }).catch(() => undefined);

  try {
    return await Promise.race([exited, late]);
  } finally {
    abort.abort();
  }
};

export const createMcpOAuthSource = (deps: McpOAuthDeps) => {
  const rejected = new Map<string, string>();

  const usable = (key: string, entry: McpAuthEntry | undefined) =>
    isFreshMcpToken(entry, deps.now()) && entry?.access !== rejected.get(key)
      ? (entry as McpAuthEntry & { access: string })
      : undefined;

  const target = (key: string, ref: McpOAuthRef) => {
    const { server, url } = ref.mcpOAuth;

    if (!MCP_SERVER_NAME.test(server)) {
      throw unavailable(`mcpOAuth secret for ${key}: ${server} is not a valid server name`);
    }

    return { server, url, id: mcpAuthKey(server, url) };
  };

  const resolve = async (key: string, ref: McpOAuthRef): Promise<CachedSecret> => {
    const { server, url, id } = target(key, ref);
    const entry = await readMcpAuthEntry(deps.hostAgentDir, server, url);
    const current = usable(id, entry);

    if (current !== undefined) {
      return cachedOf(current);
    }

    const login = await deps.signIn.start(server, url, isFreshMcpToken(entry, deps.now()));
    const code =
      login === undefined ? undefined : await within(login.exited, deps.signInWaitMs ?? SIGN_IN_WAIT_MS);
    const after = code === 0 ? usable(id, await readMcpAuthEntry(deps.hostAgentDir, server, url)) : undefined;

    if (after !== undefined) {
      return cachedOf(after);
    }

    throw signInReply(`mcpOAuth secret for ${key}: ${server} is not signed in on the host`, replyFor(server));
  };

  const reject = async (key: string, ref: McpOAuthRef, value: string): Promise<SecretReply> => {
    const { server, url, id } = target(key, ref);

    rejected.set(id, value);

    await deps.signIn.start(server, url, true);

    return replyFor(server);
  };

  return { resolve, reject };
};
