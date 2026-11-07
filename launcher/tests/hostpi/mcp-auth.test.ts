import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mcpLoginServer, oneServerDir, prepareMcpLogin, seedMcpAuth } from "../../hostpi/index.ts";
import { sanitizeMcpServer } from "../../hostpi/mcp-auth.ts";
import { mcpAuthKey, stateLayout } from "../../shared/index.ts";
import { braced, SECRETS, tempDir, writeJson, writeText } from "./fixtures.ts";

const readJson = async (path: string) => JSON.parse(await readFile(path, "utf8"));

const USER_SERVER = {
  url: "https://mcp.user.example/mcp",
  headers: { "X-Extra": SECRETS.mcpLiteral },
  env: { TOKEN: SECRETS.stdioEnv },
  oauth: {
    clientId: "client-1",
    callbackPort: 8765,
    pkce: true,
    clientSecret: braced("CLIENT_SECRET"),
    scope: "!print-scope",
  },
};

const hostDirs = async () => {
  const hostAgentDir = await tempDir("mcp-host");
  const repo = await tempDir("mcp-repo");
  const projectMcpFile = join(repo, ".pi", "mcp.json");

  await writeJson(join(hostAgentDir, "mcp.json"), {
    mcpServers: { user: USER_SERVER, local: { command: "npx" } },
  });

  await writeJson(projectMcpFile, {
    mcpServers: {
      projectOnly: { url: "https://mcp.project.example/mcp" },
      user: { url: "https://evil.example" },
    },
  });

  return { hostAgentDir, projectMcpFile };
};

describe("sanitizeMcpServer", () => {
  it("keeps the url and plain oauth values and drops headers, env, commands and variables", () => {
    expect(sanitizeMcpServer(USER_SERVER)).toEqual({
      url: "https://mcp.user.example/mcp",
      oauth: { clientId: "client-1", callbackPort: 8765, pkce: true },
    });
  });

  it("refuses stdio servers and urls built from variables", () => {
    expect(sanitizeMcpServer({ command: "npx", url: "https://x.example" })).toBeUndefined();
    expect(sanitizeMcpServer({ url: `https://${braced("HOST")}/mcp` })).toBeUndefined();
    expect(sanitizeMcpServer("https://x.example")).toBeUndefined();
  });
});

describe("mcpLoginServer", () => {
  it("takes a user server from the host file even when the project redefines it", async () => {
    const dirs = await hostDirs();
    const server = await mcpLoginServer({ ...dirs, name: "user", confirm: async () => false });

    expect(server.url).toBe("https://mcp.user.example/mcp");
  });

  it("uses a project-only server only after confirmation", async () => {
    const dirs = await hostDirs();

    await expect(
      mcpLoginServer({ ...dirs, name: "projectOnly", confirm: async () => false }),
    ).rejects.toThrow(/not confirmed/);

    await expect(
      mcpLoginServer({ ...dirs, name: "projectOnly", confirm: async () => true }),
    ).resolves.toEqual({
      url: "https://mcp.project.example/mcp",
    });
  });

  it("refuses unknown and stdio servers", async () => {
    const dirs = await hostDirs();

    await expect(mcpLoginServer({ ...dirs, name: "missing", confirm: async () => true })).rejects.toThrow(
      /no such/,
    );

    await expect(mcpLoginServer({ ...dirs, name: "local", confirm: async () => true })).rejects.toThrow(
      /not an HTTP/,
    );
  });
});

describe("prepareMcpLogin", () => {
  it("records the sanitised server and writes a one-server mcp.json in the helper dir", async () => {
    const stateDir = await tempDir("mcp-state");
    const layout = stateLayout(stateDir);
    const result = await prepareMcpLogin({ stateDir, name: "user", server: USER_SERVER as never });
    const expected = {
      url: "https://mcp.user.example/mcp",
      oauth: { clientId: "client-1", callbackPort: 8765, pkce: true },
    };

    expect(result).toEqual({ agentDir: layout.mcpAuth });
    expect(await readJson(layout.mcpAuthServer("user"))).toEqual(expected);
    expect(await readJson(join(layout.mcpAuth, "mcp.json"))).toEqual({ mcpServers: { user: expected } });

    const written = await readFile(join(layout.mcpAuth, "mcp.json"), "utf8");

    Object.values(SECRETS).forEach((secret) => {
      expect(written).not.toContain(secret);
    });
    expect(written).not.toContain("CLIENT_SECRET");
    expect(written).not.toContain("headers");
  });

  it("refuses names that are not pi server names", async () => {
    const stateDir = await tempDir("mcp-state");

    await expect(
      prepareMcpLogin({ stateDir, name: "../escape", server: { url: "https://x.example" } }),
    ).rejects.toThrow(/server name/);
  });

  it("rebuilds the one-server file from the recorded definition for a refresh", async () => {
    const stateDir = await tempDir("mcp-state");
    const layout = stateLayout(stateDir);

    await prepareMcpLogin({ stateDir, name: "first", server: { url: "https://first.example/mcp" } });

    await prepareMcpLogin({ stateDir, name: "second", server: { url: "https://second.example/mcp" } });

    expect(await oneServerDir(stateDir, "first")).toBe(layout.mcpAuth);
    expect(await readJson(join(layout.mcpAuth, "mcp.json"))).toEqual({
      mcpServers: { first: { url: "https://first.example/mcp" } },
    });

    await expect(oneServerDir(stateDir, "unknown")).rejects.toThrow(/no recorded server/);
  });
});

describe("seedMcpAuth", () => {
  const token = { tokens: { access_token: "a", refresh_token: "r" }, tokensExpireAt: 1 };

  it("copies a missing token entry from the host store and reports the signed-in servers", async () => {
    const stateDir = await tempDir("mcp-state");
    const agentDir = await tempDir("mcp-host");
    const layout = stateLayout(stateDir);
    const mcp = {
      mcpServers: {
        user: { url: "https://mcp.user.example/mcp" },
        legacy: { url: "https://mcp.legacy.example/mcp" },
        unsigned: { url: "https://mcp.unsigned.example/mcp" },
        withHeader: { url: "https://mcp.header.example/mcp", headers: { Authorization: "x" } },
        stdio: { command: "npx" },
      },
    };

    await writeJson(join(agentDir, "mcp-auth.json"), {
      [mcpAuthKey("user", "https://mcp.user.example/mcp")]: token,
      "https://mcp.legacy.example/mcp": token,
      [mcpAuthKey("withHeader", "https://mcp.header.example/mcp")]: token,
    });

    const result = await seedMcpAuth({ stateDir, files: { agentDir, mcp } });
    const store = await readJson(join(layout.mcpAuth, "mcp-auth.json"));

    expect(result.signedIn).toEqual(["user", "legacy"]);
    expect(Object.keys(store).sort()).toEqual(
      [
        mcpAuthKey("user", "https://mcp.user.example/mcp"),
        mcpAuthKey("legacy", "https://mcp.legacy.example/mcp"),
      ].sort(),
    );
    expect(await readJson(layout.mcpAuthServer("user"))).toEqual({ url: "https://mcp.user.example/mcp" });
  });

  it("keeps a token already in the helper store", async () => {
    const stateDir = await tempDir("mcp-state");
    const agentDir = await tempDir("mcp-host");
    const key = mcpAuthKey("user", "https://mcp.user.example/mcp");
    const helperToken = { tokens: { access_token: "helper" } };

    await writeJson(join(stateLayout(stateDir).mcpAuth, "mcp-auth.json"), { [key]: helperToken });

    await writeJson(join(agentDir, "mcp-auth.json"), { [key]: token });

    const result = await seedMcpAuth({
      stateDir,
      files: { agentDir, mcp: { mcpServers: { user: { url: "https://mcp.user.example/mcp" } } } },
    });

    expect(result.signedIn).toEqual(["user"]);
    expect((await readJson(join(stateLayout(stateDir).mcpAuth, "mcp-auth.json")))[key]).toEqual(helperToken);
  });

  it("leaves a helper store that does not parse untouched and seeds nothing", async () => {
    const stateDir = await tempDir("mcp-state");
    const agentDir = await tempDir("mcp-host");
    const key = mcpAuthKey("user", "https://mcp.user.example/mcp");
    const storePath = stateLayout(stateDir).mcpAuthStore;

    await writeText(storePath, "{broken");

    await writeJson(join(agentDir, "mcp-auth.json"), { [key]: token });

    const result = await seedMcpAuth({
      stateDir,
      files: { agentDir, mcp: { mcpServers: { user: { url: "https://mcp.user.example/mcp" } } } },
    });

    expect(result.signedIn).toEqual([]);
    expect(await readFile(storePath, "utf8")).toBe("{broken");
  });
});
