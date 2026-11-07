import { chmod, lstat, mkdir, readdir, readFile, rm, stat, symlink, utimes } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { syncContainerMcpAuth } from "../../provision/index.ts";
import { placeholderFor, readJsonFile, stateLayout } from "../../shared/index.ts";
import { createFakeBackend } from "../support/fake-backend.ts";
import { runningContainer, tempDir, writeText } from "./fixtures.ts";

const ACCESS = placeholderFor("salt", "mcp:docs:oauth");

const REFRESH = placeholderFor("salt", "mcp:docs:oauth:refresh");

const OTHER = placeholderFor("salt", "mcp:other:oauth");

const DOCS = "mcp__docs|https://mcp.docs.example/mcp";

const STRAY = "mcp__stray|https://mcp.stray.example/mcp";

const KEPT = "mcp__kept|https://mcp.kept.example/mcp";

const setup = async (existing?: unknown) => {
  const agentDir = await tempDir("container-agent");
  const stateDir = await tempDir("container-state");

  if (existing !== undefined) {
    await writeText(join(agentDir, "mcp-auth.json"), JSON.stringify(existing));
  }

  const fake = createFakeBackend({ guestAgentDir: agentDir });
  const containerId = await runningContainer(fake.backend);
  const sync = (entries: Parameters<typeof syncContainerMcpAuth>[0]["entries"]) =>
    syncContainerMcpAuth({ backend: fake.backend, containerId, stateDir, repoHash: "repo1", entries });
  const file = async () => {
    const text = await fake.guestFile("mcp-auth.json");

    return text === undefined ? undefined : (JSON.parse(text) as Record<string, Record<string, unknown>>);
  };

  return { agentDir, stateDir, fake, sync, file };
};

const docsEntry = {
  serverUrl: "https://mcp.docs.example/mcp",
  clientInformation: { client_id: "docs-client" },
  tokens: { access_token: ACCESS, token_type: "Bearer", refresh_token: REFRESH },
  discovery: { authorizationServerUrl: "https://auth.docs.example/" },
};

describe("syncContainerMcpAuth", () => {
  it("merges the vault entries over the container file and keeps the container's other state", async () => {
    const env = await setup({
      [DOCS]: { serverUrl: "https://mcp.docs.example/mcp", codeVerifier: "verifier", tokensExpireAt: 99 },
      [KEPT]: {
        serverUrl: "https://mcp.kept.example/mcp",
        tokens: { access_token: OTHER, token_type: "Bearer" },
      },
    });
    const result = await env.sync({ [DOCS]: docsEntry });

    expect(result.notices).toEqual([]);
    expect(await env.file()).toEqual({
      [DOCS]: { ...docsEntry, codeVerifier: "verifier" },
      [KEPT]: {
        serverUrl: "https://mcp.kept.example/mcp",
        tokens: { access_token: OTHER, token_type: "Bearer" },
      },
    });
  });

  it("drops the container's tokens for a vault key that has none on the host", async () => {
    const env = await setup({
      [DOCS]: {
        serverUrl: "https://mcp.docs.example/mcp",
        tokens: { access_token: ACCESS, token_type: "Bearer" },
      },
    });

    await env.sync({ [DOCS]: { serverUrl: "https://mcp.docs.example/mcp", discovery: {} } });

    expect(await env.file()).toEqual({
      [DOCS]: { serverUrl: "https://mcp.docs.example/mcp", discovery: {} },
    });
  });

  it("sweeps a token that is not a placeholder from any key, with a notice", async () => {
    const env = await setup({
      [STRAY]: {
        serverUrl: "https://mcp.stray.example/mcp",
        tokens: { access_token: "REAL-ACCESS-77", token_type: "Bearer", refresh_token: "REAL-REFRESH-78" },
        tokensExpireAt: 5,
      },
      [KEPT]: {
        serverUrl: "https://mcp.kept.example/mcp",
        tokens: { access_token: OTHER, token_type: "Bearer", id_token: "REAL-ID-79" },
      },
    });
    const result = await env.sync({});
    const text = await readFile(join(env.agentDir, "mcp-auth.json"), "utf8");

    expect(text).not.toMatch(/REAL-/);
    expect(await env.file()).toEqual({
      [STRAY]: { serverUrl: "https://mcp.stray.example/mcp" },
      [KEPT]: {
        serverUrl: "https://mcp.kept.example/mcp",
        tokens: { access_token: OTHER, token_type: "Bearer" },
      },
    });
    expect(result.notices).toEqual([
      `mcp: removed a token that is not a placeholder from the sandbox's mcp-auth.json (${STRAY})`,
      `mcp: removed a token that is not a placeholder from the sandbox's mcp-auth.json (${KEPT})`,
    ]);
  });

  it("replaces a symlink at the path with a private regular file and leaves its target alone", async () => {
    const env = await setup();
    const target = join(env.agentDir, "render-mcp-auth.json");

    await writeText(target, "{}\n");

    await symlink(target, join(env.agentDir, "mcp-auth.json"));

    await env.sync({ [DOCS]: docsEntry });

    const info = await lstat(join(env.agentDir, "mcp-auth.json"));

    expect(info.isFile()).toBe(true);
    expect(info.mode & 0o777).toBe(0o600);
    expect(await readFile(target, "utf8")).toBe("{}\n");
    expect(await env.file()).toEqual({ [DOCS]: docsEntry });
  });

  it("keeps a base copy of what it wrote on the host and releases the container lock", async () => {
    const env = await setup();

    await env.sync({ [DOCS]: docsEntry });

    const base = stateLayout(env.stateDir).syncMcpAuth("repo1");

    expect(await readJsonFile(base)).toEqual({ [DOCS]: docsEntry });
    expect((await stat(base)).mode & 0o777).toBe(0o600);
    await expect(lstat(join(env.agentDir, "mcp-auth.json.lock"))).rejects.toThrow();
  });

  it("waits for a lock held inside the container before it reads", async () => {
    const env = await setup({ [KEPT]: { serverUrl: "https://mcp.kept.example/mcp" } });
    const lock = join(env.agentDir, "mcp-auth.json.lock");

    await mkdir(lock);

    const pending = env.sync({ [DOCS]: docsEntry });

    await new Promise((resolve) => setTimeout(resolve, 200));

    await writeText(join(env.agentDir, "mcp-auth.json"), JSON.stringify({ [STRAY]: { serverUrl: "late" } }));

    await rm(lock, { recursive: true });

    await pending;

    expect(await env.file()).toEqual({ [STRAY]: { serverUrl: "late" }, [DOCS]: docsEntry });
  });

  it("removes a key whose entry is null and replaces an unreadable file with a notice", async () => {
    const env = await setup();

    await mkdir(env.agentDir, { recursive: true });

    await writeText(join(env.agentDir, "mcp-auth.json"), "{not json");

    const result = await env.sync({ [DOCS]: docsEntry, [KEPT]: null });

    expect(await env.file()).toEqual({ [DOCS]: docsEntry });
    expect(result.notices).toEqual([
      "mcp-auth.json in the sandbox volume was not valid JSON; replaced with the vault entries",
    ]);
  });

  it("sweeps a client secret from in-container registration unless it is the vault placeholder", async () => {
    const CLIENT = placeholderFor("salt", "mcp:docs:oauth:client");
    const env = await setup({
      [DOCS]: {
        serverUrl: "https://mcp.docs.example/mcp",
        clientInformation: { client_id: "docs-client", client_secret: "REAL-CLIENT-1" },
      },
      [STRAY]: {
        serverUrl: "https://mcp.stray.example/mcp",
        clientInformation: {
          client_id: "stray",
          client_secret: "REAL-CLIENT-2",
          client_secret_expires_at: 0,
        },
      },
    });
    const vaultEntry = {
      ...docsEntry,
      clientInformation: { client_id: "docs-client", client_secret: CLIENT },
    };
    const result = await env.sync({
      [DOCS]: { serverUrl: "https://mcp.docs.example/mcp", discovery: {} },
      [KEPT]: vaultEntry,
    });
    const text = await readFile(join(env.agentDir, "mcp-auth.json"), "utf8");
    const base = await readFile(stateLayout(env.stateDir).syncMcpAuth("repo1"), "utf8");

    expect(text).not.toMatch(/REAL-CLIENT/);
    expect(base).not.toMatch(/REAL-CLIENT/);
    expect((await env.file())?.[KEPT]?.clientInformation).toEqual({
      client_id: "docs-client",
      client_secret: CLIENT,
    });
    expect((await env.file())?.[STRAY]?.clientInformation).toEqual({
      client_id: "stray",
      client_secret_expires_at: 0,
    });
    expect(result.notices).toEqual([
      `mcp: removed a token that is not a placeholder from the sandbox's mcp-auth.json (${DOCS})`,
      `mcp: removed a token that is not a placeholder from the sandbox's mcp-auth.json (${STRAY})`,
    ]);
  });

  it("takes over a lock in the container only once it is older than the stale window", async () => {
    const env = await setup({ [KEPT]: { serverUrl: "https://mcp.kept.example/mcp" } });
    const lock = join(env.agentDir, "mcp-auth.json.lock");
    const old = new Date(Date.now() - 20_000);

    await mkdir(lock);

    await utimes(lock, old, old);

    await env.sync({ [DOCS]: docsEntry });

    expect(await env.file()).toEqual({
      [KEPT]: { serverUrl: "https://mcp.kept.example/mcp" },
      [DOCS]: docsEntry,
    });
    await expect(lstat(lock)).rejects.toThrow();
    expect((await readdir(env.agentDir)).filter((name) => name.startsWith("mcp-auth.json.lock"))).toEqual([]);
  });

  it("keeps waiting for a holder that refreshes its lock past the stale window", async () => {
    const env = await setup({ [KEPT]: { serverUrl: "https://mcp.kept.example/mcp" } });
    const lock = join(env.agentDir, "mcp-auth.json.lock");
    const old = new Date(Date.now() - 9_500);

    await mkdir(lock);

    await utimes(lock, old, old);

    const refresh = setInterval(() => {
      const now = new Date();

      void utimes(lock, now, now).catch(() => undefined);
    }, 200);
    const state = { settled: false };
    const pending = env.sync({ [DOCS]: docsEntry }).finally(() => {
      state.settled = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 1_000));

    expect(state.settled).toBe(false);
    expect(await env.file()).toEqual({ [KEPT]: { serverUrl: "https://mcp.kept.example/mcp" } });

    clearInterval(refresh);

    await rm(lock, { recursive: true });

    await pending;

    expect(await env.file()).toEqual({
      [KEPT]: { serverUrl: "https://mcp.kept.example/mcp" },
      [DOCS]: docsEntry,
    });
  });

  it("leaves the file alone when nothing changed", async () => {
    const env = await setup({ [DOCS]: docsEntry });
    const before = await lstat(join(env.agentDir, "mcp-auth.json"));

    await env.sync({ [DOCS]: docsEntry });

    expect((await lstat(join(env.agentDir, "mcp-auth.json"))).ino).toBe(before.ino);
    expect(env.fake.execs.filter((exec) => exec.spec.command.join(" ").includes("pi-sandbox-tmp"))).toEqual(
      [],
    );
  });

  it("makes an existing file private even when nothing changed", async () => {
    const env = await setup({ [DOCS]: docsEntry });

    await chmod(join(env.agentDir, "mcp-auth.json"), 0o644);

    await env.sync({ [DOCS]: docsEntry });

    expect((await stat(join(env.agentDir, "mcp-auth.json"))).mode & 0o777).toBe(0o600);
  });
});
