import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CredentialRule } from "../../config/index.ts";
import type { DeriveInput } from "../../hostpi/index.ts";
import { deriveSandboxPi } from "../../hostpi/index.ts";
import { isPlaceholder, jwtShapedPlaceholder, placeholderFor } from "../../shared/index.ts";
import {
  AGENT_DIR,
  braced,
  hostAuth,
  hostMcp,
  hostModels,
  JWT_ACCESS,
  providerHosts,
  SECRETS,
  tempDir,
  writeJson,
} from "./fixtures.ts";

const SALT = "c".repeat(64);

const input = (overrides: Partial<DeriveInput> = {}): DeriveInput => ({
  files: { agentDir: AGENT_DIR, auth: hostAuth(), models: hostModels(), mcp: hostMcp() },
  providerHosts: providerHosts(),
  manual: [],
  salt: SALT,
  env: { ENVONLY_API_KEY: SECRETS.envValue },
  derive: { enabled: true },
  mcpSignedIn: ["sentryish"],
  ...overrides,
});

const P = (identity: string) => placeholderFor(SALT, identity);

const rulesOf = (rules: CredentialRule[], id: string) => rules.filter((rule) => rule.id === id);

describe("deriveSandboxPi auth.json", () => {
  it("turns api_key entries into placeholders bound to the host pi credential", () => {
    const result = deriveSandboxPi(input());

    expect(result.files["auth.json"].keyed).toEqual({ type: "api_key", key: P("auth:keyed:key") });
    expect(rulesOf(result.rules, "derived:auth:keyed:key")).toEqual([
      {
        id: "derived:auth:keyed:key",
        host: "api.keyed.example",
        placeholder: P("auth:keyed:key"),
        secret: { piAuth: "keyed" },
      },
    ]);
  });

  it("keeps non-secret oauth fields, shapes a JWT access placeholder and pushes expiry far out", () => {
    const result = deriveSandboxPi(input());
    const access = jwtShapedPlaceholder(JWT_ACCESS, SALT, "auth:jwt:access");

    expect(result.files["auth.json"].jwt).toEqual({
      type: "oauth",
      accountId: "account-7",
      access,
      refresh: P("auth:jwt:refresh"),
      expires: 4102444800000,
    });
    expect(isPlaceholder(access)).toBe(true);
    expect(rulesOf(result.rules, "derived:auth:jwt:access").map((rule) => rule.host)).toEqual([
      "api.jwt.example",
      "alt.jwt.example",
    ]);
    expect(rulesOf(result.rules, "derived:auth:jwt:access")[0]).toMatchObject({
      placeholder: access,
      secret: { piAuth: "jwt", bearer: true },
    });
  });

  it("uses an opaque access placeholder for a token that is not a JWT", () => {
    const result = deriveSandboxPi(input());

    expect(result.files["auth.json"].opaque).toMatchObject({ access: P("auth:opaque:access") });
  });

  it("gives an entry without a known host a placeholder, a notice and no rule", () => {
    const result = deriveSandboxPi(input());

    expect(result.files["auth.json"].stray).toEqual({ type: "api_key", key: P("auth:stray:key") });
    expect(rulesOf(result.rules, "derived:auth:stray:key")).toEqual([]);
    expect(result.notices).toContain(
      "auth stray: no known API host, so no credential rule; add credentials.rules for it",
    );
  });

  it("adds an api_key placeholder for a provider whose key comes from the launcher environment", () => {
    const result = deriveSandboxPi(input());

    expect(result.files["auth.json"].envOnly).toEqual({ type: "api_key", key: P("auth:envOnly:key") });
    expect(rulesOf(result.rules, "derived:auth:envOnly:key")[0]).toMatchObject({
      host: "api.envonly.example",
      secret: { piAuth: "envOnly" },
    });
    expect(deriveSandboxPi(input({ env: {} })).files["auth.json"].envOnly).toBeUndefined();
  });
});

describe("deriveSandboxPi models.json", () => {
  const custom = () => {
    const providers = deriveSandboxPi(input()).files["models.json"].providers as Record<
      string,
      Record<string, unknown>
    >;

    return providers.custom as Record<string, unknown>;
  };

  it("replaces apiKey with a placeholder on the provider and model hosts", () => {
    const result = deriveSandboxPi(input());

    expect(custom().apiKey).toBe(P("models:custom:apiKey"));
    expect(custom().authHeader).toBe(true);
    expect(rulesOf(result.rules, "derived:models:custom:apiKey").map((rule) => rule.host)).toEqual([
      "llm.custom.example",
      "model-a.custom.example",
    ]);
  });

  it("binds env, command and literal header values and leaves plain ones", () => {
    const result = deriveSandboxPi(input());
    const headers = custom().headers as Record<string, string>;
    const rule = (name: string) => rulesOf(result.rules, `derived:models:custom:header:${name}`)[0];

    expect(headers).toEqual({
      "X-Api-Key": P("models:custom:header:x-api-key"),
      "X-Team": P("models:custom:header:x-team"),
      "X-Signed": P("models:custom:header:x-signed"),
      "X-Trace": "plain-value",
    });
    expect(rule("x-api-key")).toMatchObject({
      header: "X-Api-Key",
      template: "{secret}",
      secret: { file: `${AGENT_DIR}/models.json`, pointer: "/providers/custom/headers/X-Api-Key" },
    });
    expect(rule("x-team")?.secret).toEqual({ env: "TEAM_TOKEN" });
    expect(rule("x-signed")?.secret).toEqual({ command: ["sh", "-c", "print-signature --now"] });
  });

  it("binds model-level headers to the model host and resolves them by model id, not array position", async () => {
    const agentDir = await tempDir("models-identity");
    const models = hostModels();
    const file = join(agentDir, "models.json");

    await writeJson(file, models);

    const result = deriveSandboxPi(input({ files: { agentDir, auth: hostAuth(), models, mcp: hostMcp() } }));
    const rules = rulesOf(result.rules, "derived:models:custom:model:model-a:header:authorization");
    const resolve = () => {
      const secret = rules[0]?.secret;
      const [command = "", ...args] = secret !== undefined && "command" in secret ? secret.command : [];

      return spawnSync(command, args, { encoding: "utf8" });
    };

    expect(rules).toMatchObject([
      {
        host: "model-a.custom.example",
        placeholder: P("models:custom:model:model-a:header:authorization"),
        header: "Authorization",
        template: "{secret}",
      },
    ]);
    expect(resolve().stdout).toBe(SECRETS.modelHeader);

    const custom = models.providers.custom;

    await writeJson(file, {
      providers: {
        custom: {
          ...custom,
          models: [
            { id: "model-b", baseUrl: "https://evil.example", headers: { Authorization: "B-SECRET" } },
            ...custom.models,
          ],
        },
      },
    });

    expect(resolve().stdout).toBe(SECRETS.modelHeader);

    await writeJson(file, {
      providers: {
        custom: { ...custom, models: [{ ...custom.models[0], baseUrl: "https://moved.example" }] },
      },
    });

    expect(resolve().status).not.toBe(0);
    expect(resolve().stdout).toBe("");
  });

  it("warns about host-local endpoints and providers without a host and gives them no rule", () => {
    const result = deriveSandboxPi(input());

    expect(result.notices).toContain(
      "models local: localhost is a host-local or plain-http endpoint, not reachable from the sandbox",
    );
    expect(result.notices).toContain(
      "models unknownHost: no known API host, so no credential rule; add credentials.rules for it",
    );
    expect(result.rules.filter((rule) => rule.id.startsWith("derived:models:local"))).toEqual([]);
  });
});

describe("deriveSandboxPi mcp.json", () => {
  const servers = (result = deriveSandboxPi(input())) =>
    result.files["mcp.json"].mcpServers as Record<string, Record<string, unknown>>;

  it("keeps the header shape around an embedded variable and binds the variable", () => {
    const result = deriveSandboxPi(input());
    const placeholder = P("mcp:docs:header:authorization");

    expect(servers(result).docs?.headers).toEqual({ Authorization: `Bearer ${placeholder}` });
    expect(rulesOf(result.rules, "derived:mcp:docs:header:authorization")).toEqual([
      {
        id: "derived:mcp:docs:header:authorization",
        host: "mcp.docs.example",
        placeholder,
        header: "Authorization",
        template: "Bearer {secret}",
        secret: { env: "DOCS_TOKEN" },
      },
    ]);
    expect(rulesOf(result.rules, "derived:mcp:docs:oauth")).toEqual([]);
  });

  it("adds a bearer placeholder for servers without Authorization and drops their oauth block", () => {
    const result = deriveSandboxPi(input());
    const placeholder = P("mcp:sentryish:oauth");

    expect(servers(result).sentryish).toEqual({
      url: "https://mcp.oauth.example/mcp",
      headers: { Authorization: `Bearer ${placeholder}` },
    });
    expect(rulesOf(result.rules, "derived:mcp:sentryish:oauth")).toEqual([
      {
        id: "derived:mcp:sentryish:oauth",
        host: "mcp.oauth.example",
        placeholder,
        secret: { mcpOAuth: { server: "sentryish", url: "https://mcp.oauth.example/mcp" } },
      },
    ]);
  });

  it("asks for a sign-in only for servers without a token in the helper dir", () => {
    const result = deriveSandboxPi(input());

    expect(result.notices).toContain("mcp literal: sign in with pi mcp login literal");
    expect(result.notices).not.toContain("mcp sentryish: sign in with pi mcp login sentryish");
  });

  it("points a literal secret header at the host mcp.json", () => {
    const result = deriveSandboxPi(input());

    expect(rulesOf(result.rules, "derived:mcp:literal:header:x-auth-token")[0]?.secret).toEqual({
      file: `${AGENT_DIR}/mcp.json`,
      pointer: "/mcpServers/literal/headers/X-Auth-Token",
    });
  });

  it("gives plain-http servers a notice and no rule", () => {
    const result = deriveSandboxPi(input());

    expect(result.notices).toContain(
      "mcp plain: intranet.example is a host-local or plain-http endpoint, not reachable from the sandbox",
    );
    expect(result.rules.filter((rule) => rule.id.startsWith("derived:mcp:plain"))).toEqual([]);
  });

  it("turns secret-like stdio env values into placeholders with a notice", () => {
    const result = deriveSandboxPi(input());

    expect(servers(result).tools?.env).toEqual({
      API_TOKEN: P("mcp:tools:env:API_TOKEN"),
      FROM_ENV: P("mcp:tools:env:FROM_ENV"),
      RUN: P("mcp:tools:env:RUN"),
      MODE: "fast",
    });
    expect(result.notices).toContain(
      "mcp tools: API_TOKEN is a placeholder in the sandbox; add credentials.rules for the host it calls",
    );
  });

  it("drops stdio env values and args that carry URL userinfo or a secret-named flag value", () => {
    const mcp = {
      mcpServers: {
        cli: {
          command: "tool",
          args: [
            "serve",
            "--api-key=LITERAL-ARG-SECRET",
            "-token=LITERAL-SHORT-SECRET",
            "https://me:URL-ARG-SECRET@db.example/x",
            "--db=postgres://u:FLAG-URL-SECRET@db.example/app",
            "--port=8080",
          ],
          env: { DATABASE_URL: "postgres://admin:ENV-URL-SECRET@db.example/app", MODE: "fast" },
        },
      },
    };
    const result = deriveSandboxPi(input({ files: { agentDir: AGENT_DIR, mcp } }));
    const cli = servers(result).cli;

    expect(JSON.stringify(result.files["mcp.json"])).not.toMatch(/SECRET/);
    expect(cli?.args).toEqual([
      "serve",
      `--api-key=${P("mcp:cli:arg:1")}`,
      `-token=${P("mcp:cli:arg:2")}`,
      P("mcp:cli:arg:3"),
      `--db=${P("mcp:cli:arg:4")}`,
      "--port=8080",
    ]);
    expect(cli?.env).toEqual({ DATABASE_URL: P("mcp:cli:env:DATABASE_URL"), MODE: "fast" });
    expect(result.notices).toEqual(
      expect.arrayContaining([
        "mcp cli: --api-key is a placeholder in the sandbox; add credentials.rules for the host it calls",
        "mcp cli: args[3] is a placeholder in the sandbox; add credentials.rules for the host it calls",
        "mcp cli: DATABASE_URL is a placeholder in the sandbox; add credentials.rules for the host it calls",
      ]),
    );
  });

  it("turns literal cookie, session, access and proxy credential headers into placeholders", () => {
    const headers = {
      Cookie: "session=LIT-COOKIE",
      "Set-Cookie": "a=LIT-SET",
      "Proxy-Authorization": "Basic LIT-PROXY",
      "X-Auth-User": "LIT-XAUTH",
      "X-Api-Tenant": "LIT-XAPI",
      "X-Access-Id": "LIT-XACCESS",
      "X-Session-Id": "LIT-XSESSION",
      "X-Trace": "plain",
    };
    const mcp = { mcpServers: { lit: { url: "https://lit.example/mcp", headers } } };
    const result = deriveSandboxPi(input({ files: { agentDir: AGENT_DIR, mcp } }));

    expect(JSON.stringify(result.files["mcp.json"])).not.toMatch(/LIT-/);
    expect(servers(result).lit?.headers).toMatchObject({ "X-Trace": "plain" });
    expect(rulesOf(result.rules, "derived:mcp:lit:header:cookie")[0]).toMatchObject({
      host: "lit.example",
      header: "Cookie",
      secret: { file: `${AGENT_DIR}/mcp.json`, pointer: "/mcpServers/lit/headers/Cookie" },
    });
  });

  it("drops a server whose url carries a credential in its query string and keeps it out of the vault", () => {
    const mcp = {
      mcpServers: {
        keyed: { url: "https://q.example/mcp?api_key=QUERY-SECRET&x=1" },
        signed: { url: "https://s.example/mcp?sig=QUERY-SIG" },
        plain: { url: "https://p.example/mcp?region=eu" },
      },
    };
    const discovery = {
      ok: true as const,
      server: "keyed",
      url: "https://q.example/mcp?api_key=QUERY-SECRET&x=1",
      fetchedAt: 1,
      issuer: "https://auth.q.example",
      authorizationEndpoint: "https://auth.q.example/authorize",
      tokenEndpoint: "https://auth.q.example/token",
      hosts: ["auth.q.example"],
      piState: {},
    };
    const result = deriveSandboxPi(
      input({
        files: { agentDir: AGENT_DIR, mcp },
        vault: { enabled: true, discovery: { keyed: discovery } },
      }),
    );

    expect(Object.keys(servers(result))).toEqual(["plain"]);
    expect(JSON.stringify(result.files)).not.toMatch(/QUERY-/);
    expect(result.vault).toEqual([]);
    expect(result.rules.filter((rule) => rule.id.startsWith("derived:mcp:keyed"))).toEqual([]);
    expect(result.notices).toContain(
      "mcp keyed: the url carries a credential in its query string; add a header rule instead",
    );
    expect(result.notices).toContain(
      "mcp signed: the url carries a credential in its query string; add a header rule instead",
    );
  });

  it("leaves a header that combines several variables unbound with a notice", () => {
    const mcp = {
      mcpServers: {
        multi: {
          url: "https://multi.example/mcp",
          headers: { Authorization: `${braced("A")}:${braced("B")}` },
        },
      },
    };
    const result = deriveSandboxPi(input({ files: { agentDir: AGENT_DIR, mcp } }));

    expect(rulesOf(result.rules, "derived:mcp:multi:header:authorization")).toEqual([]);
    expect(result.notices.some((notice) => notice.startsWith("mcp multi: header Authorization"))).toBe(true);
  });
});

describe("deriveSandboxPi rules and hosts", () => {
  const manual: CredentialRule = {
    id: "corp-keyed",
    host: "api.keyed.example",
    placeholder: "pi-sandbox-manual",
    secret: { env: "CORP_KEY" },
  };

  it("lets a manual rule replace derived rules for its host", () => {
    const result = deriveSandboxPi(input({ manual: [manual] }));

    expect(result.rules.filter((rule) => rule.host === "api.keyed.example")).toEqual([manual]);
    expect(result.hosts).not.toContain("api.keyed.example");
  });

  it("lists derived hosts once and honours derive.enabled and derive.hosts", () => {
    const all = deriveSandboxPi(input());
    const limited = deriveSandboxPi(input({ derive: { enabled: true, hosts: ["*.custom.example"] } }));
    const disabled = deriveSandboxPi(input({ derive: { enabled: false }, manual: [manual] }));

    expect(new Set(all.hosts).size).toBe(all.hosts.length);
    expect(all.hosts).toContain("mcp.oauth.example");
    expect(limited.hosts).toEqual(["llm.custom.example", "model-a.custom.example"]);
    expect(deriveSandboxPi(input({ derive: { enabled: true, hosts: ["*.example"] } })).hosts).not.toContain(
      "llm.custom.example",
    );
    expect(disabled.hosts).toEqual([]);
    expect(disabled.rules).toEqual([manual]);
  });

  it("passes read notices through", () => {
    const result = deriveSandboxPi(
      input({ files: { agentDir: AGENT_DIR, notices: ["auth.json: invalid JSON, ignored"] } }),
    );

    expect(result.notices).toContain("auth.json: invalid JSON, ignored");
  });
});

describe("deriveSandboxPi url userinfo", () => {
  const PASSWORD = "SECRET-USERINFO-PASSWORD-83";

  const files = () => ({
    agentDir: AGENT_DIR,
    models: {
      providers: {
        proxied: {
          baseUrl: `https://bob:${PASSWORD}@llm.proxied.example/v1`,
          models: [{ id: "m1", baseUrl: `https://amy:${PASSWORD}@m1.proxied.example/v1` }],
        },
      },
    },
    mcp: { mcpServers: { guarded: { url: `https://eve:${PASSWORD}@mcp.guarded.example/mcp` } } },
  });

  it("strips userinfo from every url, names the key and adds a Basic header rule", () => {
    const result = deriveSandboxPi(input({ files: files() }));
    const providers = result.files["models.json"].providers as Record<string, Record<string, unknown>>;
    const servers = result.files["mcp.json"].mcpServers as Record<string, Record<string, unknown>>;

    expect(JSON.stringify(result.files)).not.toContain(PASSWORD);
    expect(JSON.stringify(result.files)).not.toContain("bob");
    expect(JSON.stringify(result.notices)).not.toContain(PASSWORD);
    expect(providers.proxied?.baseUrl).toBe("https://llm.proxied.example/v1");
    expect(servers.guarded?.url).toBe("https://mcp.guarded.example/mcp");
    expect(result.notices).toContain(
      "models proxied: providers.proxied.baseUrl carried user credentials; they were removed in the sandbox",
    );
    expect(rulesOf(result.rules, "derived:models:proxied:baseUrl:userinfo")).toEqual([
      {
        id: "derived:models:proxied:baseUrl:userinfo",
        host: "llm.proxied.example",
        header: "Authorization",
        template: "Basic {secret}",
        transform: "urlUserinfoBase64",
        secret: { file: `${AGENT_DIR}/models.json`, pointer: "/providers/proxied/baseUrl" },
      },
    ]);
    expect(rulesOf(result.rules, "derived:models:proxied:model:m1:baseUrl:userinfo")[0]?.host).toBe(
      "m1.proxied.example",
    );
    expect(servers.guarded?.headers).toBeUndefined();
    expect(rulesOf(result.rules, "derived:mcp:guarded:oauth")).toEqual([]);
    expect(result.notices).not.toContain("mcp guarded: sign in with pi mcp login guarded");
    expect(rulesOf(result.rules, "derived:mcp:guarded:url:userinfo")[0]).toMatchObject({
      host: "mcp.guarded.example",
      transform: "urlUserinfoBase64",
      secret: { file: `${AGENT_DIR}/mcp.json`, pointer: "/mcpServers/guarded/url" },
    });
  });
});

describe("deriveSandboxPi safety and stability", () => {
  it("never puts a real secret into the files, rules or notices", () => {
    const text = JSON.stringify(deriveSandboxPi(input()));

    Object.values(SECRETS).forEach((secret) => {
      expect(text).not.toContain(secret);
    });
  });

  it("gives the same output for the same input", () => {
    expect(JSON.stringify(deriveSandboxPi(input()))).toBe(JSON.stringify(deriveSandboxPi(input())));
  });

  it("works with no host files", () => {
    const result = deriveSandboxPi(input({ files: { agentDir: AGENT_DIR }, env: {} }));

    expect(result.files).toEqual({
      "auth.json": {},
      "models.json": { providers: {} },
      "mcp.json": { mcpServers: {} },
    });
    expect(result.rules).toEqual([]);
  });
});
