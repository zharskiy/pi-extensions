import { describe, expect, it } from "vitest";
import type { CredentialRule } from "../../config/index.ts";
import { type DeriveInput, deriveSandboxPi, vaultCandidates } from "../../hostpi/index.ts";
import { isPlaceholder, placeholderFor } from "../../shared/index.ts";
import { AGENT_DIR, braced, SECRETS, vaultDiscovery } from "./fixtures.ts";

const SALT = "d".repeat(64);

const P = (identity: string) => placeholderFor(SALT, identity);

const VAULT_URL = "https://mcp.vault.example/mcp";

const SECRET_URL = "https://mcp.secret.example/mcp";

const hostMcp = () => ({
  mcpServers: {
    vaulted: {
      url: VAULT_URL,
      headers: { "X-Team": "plain-team" },
      oauth: { clientId: "client-7", scope: "read write", callbackPort: 33418, clientName: braced("NAME") },
    },
    confidential: {
      url: SECRET_URL,
      oauth: { clientId: "client-9", clientSecret: SECRETS.oauthClient },
    },
  },
});

const input = (overrides: Partial<DeriveInput> = {}): DeriveInput => ({
  files: { agentDir: AGENT_DIR, mcp: hostMcp() },
  providerHosts: {},
  manual: [],
  salt: SALT,
  env: {},
  derive: { enabled: true },
  mcpSignedIn: [],
  vault: {
    enabled: true,
    discovery: {
      vaulted: vaultDiscovery("vaulted", VAULT_URL),
      confidential: vaultDiscovery("confidential", SECRET_URL),
    },
  },
  ...overrides,
});

const serversOf = (result: ReturnType<typeof deriveSandboxPi>) =>
  result.files["mcp.json"].mcpServers as Record<string, Record<string, unknown>>;

const rulesOf = (rules: CredentialRule[], id: string) => rules.filter((rule) => rule.id === id);

describe("deriveSandboxPi vault servers", () => {
  it("renders a vault server with its plain oauth fields and no Authorization header", () => {
    const result = deriveSandboxPi(input());

    expect(serversOf(result).vaulted).toEqual({
      url: VAULT_URL,
      headers: { "X-Team": "plain-team" },
      oauth: { clientId: "client-7", scope: "read write", callbackPort: 33418 },
    });
    expect(rulesOf(result.rules, "derived:mcp:vaulted:oauth")).toEqual([
      {
        id: "derived:mcp:vaulted:oauth",
        host: "mcp.vault.example",
        placeholder: P("mcp:vaulted:oauth"),
        secret: { mcpOAuth: { server: "vaulted", url: VAULT_URL } },
      },
    ]);
  });

  it("lists the vault server with its placeholders and the host discovery", () => {
    const [server, ...others] = deriveSandboxPi(input()).vault;

    expect(others).toEqual([]);
    expect(server).toEqual({
      server: "vaulted",
      url: VAULT_URL,
      ruleId: "derived:mcp:vaulted:oauth",
      access: P("mcp:vaulted:oauth"),
      refresh: P("mcp:vaulted:oauth:refresh"),
      client: P("mcp:vaulted:oauth:client"),
      oauth: { clientId: "client-7", scope: "read write", callbackPort: 33418 },
      discovery: vaultDiscovery("vaulted", VAULT_URL),
    });
    expect(
      [server?.access, server?.refresh, server?.client].every((value) => isPlaceholder(value ?? "")),
    ).toBe(true);
  });

  it("keeps a server with a client secret in header mode", () => {
    const result = deriveSandboxPi(input());

    expect(serversOf(result).confidential).toEqual({
      url: SECRET_URL,
      headers: { Authorization: `Bearer ${P("mcp:confidential:oauth")}` },
    });
    expect(result.notices).toContain("mcp confidential: sign in with pi mcp login confidential");
  });

  it("tells how to sign in from inside the sandbox, and stays quiet once signed in", () => {
    const notice = "mcp vaulted: sign in from /mcp in pi, or with pi mcp login vaulted in the shell";

    expect(deriveSandboxPi(input()).notices).toContain(notice);
    expect(deriveSandboxPi(input({ mcpSignedIn: ["vaulted"] })).notices).not.toContain(notice);
  });

  it("puts no real secret in the rendered files or the vault list", () => {
    const result = deriveSandboxPi(input());

    expect(JSON.stringify([result.files, result.vault])).not.toContain(SECRETS.oauthClient);
  });

  it("falls back to header mode when the vault is off or the server's discovery failed", () => {
    const failed = {
      enabled: true,
      discovery: {
        vaulted: { ok: false as const, server: "vaulted", url: VAULT_URL, fetchedAt: 1, error: "down" },
      },
    };
    const header = { Authorization: `Bearer ${P("mcp:vaulted:oauth")}` };

    [
      input({ vault: { ...input().vault, enabled: false } as DeriveInput["vault"] }),
      input({ vault: failed }),
    ].forEach((each) => {
      const result = deriveSandboxPi(each);

      expect(serversOf(result).vaulted?.headers).toEqual({ "X-Team": "plain-team", ...header });
      expect(serversOf(result).vaulted?.oauth).toBeUndefined();
      expect(result.vault).toEqual([]);
    });
  });
});

describe("vaultCandidates", () => {
  it("keeps only public http servers without a client secret, auth, Authorization header or url password or query credential", () => {
    const candidates = vaultCandidates({
      mcpServers: {
        good: { url: "https://user@mcp.good.example/mcp", oauth: { scope: "read", clientId: braced("ID") } },
        secret: { url: "https://mcp.a.example", oauth: { clientSecret: "!pass show x" } },
        header: { url: "https://mcp.b.example", headers: { authorization: "Bearer x" } },
        password: { url: "https://user:pw@mcp.c.example" },
        query: { url: "https://mcp.q.example/mcp?token=abc" },
        auth: { url: "https://mcp.d.example", auth: { provider: "someone" } },
        local: { url: "http://localhost:3000/mcp" },
        plain: { url: "http://mcp.e.example/mcp" },
        "bad name": { url: "https://mcp.f.example" },
        stdio: { command: "tool" },
      },
    });

    expect(candidates).toEqual({ good: { url: "https://mcp.good.example/mcp", oauth: { scope: "read" } } });
  });
});
