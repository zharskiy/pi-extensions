import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CredentialRule } from "../../config/index.ts";
import type { DeriveInput } from "../../hostpi/index.ts";
import { deriveSandboxPi } from "../../hostpi/index.ts";
import { isPlaceholder, jwtShapedPlaceholder, placeholderFor, toolConfigValue } from "../../shared/index.ts";
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

  it("adds an api_key placeholder for a provider whose key comes from the launcher environment, read from that variable", () => {
    const result = deriveSandboxPi(input());

    expect(result.files["auth.json"].envOnly).toEqual({ type: "api_key", key: P("auth:envOnly:key") });
    expect(rulesOf(result.rules, "derived:auth:envOnly:key")[0]).toMatchObject({
      host: "api.envonly.example",
      secret: { env: "ENVONLY_API_KEY" },
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
    const resolve = async () => {
      const secret = rules[0]?.secret;

      return secret !== undefined && "format" in secret
        ? toolConfigValue(await readFile(secret.file, "utf8"), secret)
        : undefined;
    };

    expect(rules).toMatchObject([
      {
        host: "model-a.custom.example",
        placeholder: P("models:custom:model:model-a:header:authorization"),
        header: "Authorization",
        template: "{secret}",
      },
    ]);
    expect(await resolve()).toBe(SECRETS.modelHeader);

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

    expect(await resolve()).toBe(SECRETS.modelHeader);

    await writeJson(file, { providers: { custom: { ...custom, models: [] } } });

    expect(await resolve()).toBeUndefined();
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

describe("deriveSandboxPi models.json query credentials", () => {
  it("drops a provider or a model whose baseUrl carries a credential in its query string", () => {
    const models = {
      providers: {
        keyed: { baseUrl: "https://q.example/v1?api-key=QUERY-SECRET", apiKey: "x" },
        mixed: {
          baseUrl: "https://m.example/v1?region=eu",
          models: [{ id: "signed", baseUrl: "https://s.example/v1?key=QUERY-KEY" }, { id: "plain" }],
        },
      },
    };
    const result = deriveSandboxPi(input({ files: { agentDir: AGENT_DIR, models } }));
    const providers = result.files["models.json"].providers as Record<string, Record<string, unknown>>;

    expect(Object.keys(providers)).toEqual(["mixed"]);
    expect(providers.mixed?.models).toEqual([{ id: "plain" }]);
    expect(JSON.stringify(result)).not.toMatch(/QUERY-/);
    expect(result.notices).toContain(
      "models keyed: providers.keyed.baseUrl carries a credential in its query string; the provider stays out of the sandbox, use a header instead",
    );
    expect(result.notices).toContain(
      "models mixed: providers.mixed.models[0].baseUrl carries a credential in its query string; the model stays out of the sandbox, use a header instead",
    );
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

  it("keeps the oauth block and its client secret out of the sandbox mcp.json", () => {
    const result = deriveSandboxPi(input());

    expect(servers(result).sentryish?.oauth).toBeUndefined();
    expect(JSON.stringify(result.files)).not.toContain(SECRETS.oauthClient);
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
      "X-Api-Key": "LIT-XAPI",
      "X-Access-Token": "LIT-XACCESS",
      "X-Session-Id": "LIT-XSESSION",
      "X-Api-Version": "2",
      "X-Trace": "plain",
    };
    const mcp = { mcpServers: { lit: { url: "https://lit.example/mcp", headers } } };
    const result = deriveSandboxPi(input({ files: { agentDir: AGENT_DIR, mcp } }));

    expect(JSON.stringify(result.files["mcp.json"])).not.toMatch(/LIT-/);
    expect(servers(result).lit?.headers).toMatchObject({ "X-Trace": "plain", "X-Api-Version": "2" });
    expect(rulesOf(result.rules, "derived:mcp:lit:header:cookie")[0]).toMatchObject({
      host: "lit.example",
      header: "Cookie",
      secret: { file: `${AGENT_DIR}/mcp.json`, pointer: "/mcpServers/lit/headers/Cookie" },
    });
  });

  it("drops a server whose url carries a credential in its query string ", () => {
    const mcp = {
      mcpServers: {
        keyed: { url: "https://q.example/mcp?api_key=QUERY-SECRET&x=1" },
        signed: { url: "https://s.example/mcp?sig=QUERY-SIG" },
        plain: { url: "https://p.example/mcp?region=eu" },
      },
    };
    const result = deriveSandboxPi(input({ files: { agentDir: AGENT_DIR, mcp } }));

    expect(Object.keys(servers(result))).toEqual(["plain"]);
    expect(JSON.stringify(result.files)).not.toMatch(/QUERY-/);
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

  it("lists only the models.json baseUrl hosts of kept rules as private hosts", () => {
    const all = deriveSandboxPi(input());
    const limited = deriveSandboxPi(input({ derive: { enabled: true, hosts: ["model-a.custom.example"] } }));
    const overridden = deriveSandboxPi(input({ manual: [{ ...manual, host: "llm.custom.example" }] }));

    expect(all.privateHosts.slice().sort()).toEqual(["llm.custom.example", "model-a.custom.example"]);
    expect(all.hosts).toEqual(expect.arrayContaining(["api.keyed.example", "mcp.docs.example"]));
    expect(limited.privateHosts).toEqual(["model-a.custom.example"]);
    expect(overridden.privateHosts).toEqual(["model-a.custom.example"]);
    expect(deriveSandboxPi(input({ derive: { enabled: false } })).privateHosts).toEqual([]);
  });

  it("gives an mcp.json url host no private access even when it carries a credential rule", () => {
    const result = deriveSandboxPi(input({ files: { agentDir: AGENT_DIR, mcp: hostMcp() } }));

    expect(result.hosts).toContain("mcp.literal.example");
    expect(result.privateHosts).toEqual([]);
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

  it("strips userinfo from every url, names the key and derives no rule for it", () => {
    const result = deriveSandboxPi(input({ files: files() }));
    const providers = result.files["models.json"].providers as Record<string, Record<string, unknown>>;
    const servers = result.files["mcp.json"].mcpServers as Record<string, Record<string, unknown>>;

    expect(JSON.stringify(result)).not.toContain(PASSWORD);
    expect(JSON.stringify(result.files)).not.toContain("bob");
    expect(providers.proxied?.baseUrl).toBe("https://llm.proxied.example/v1");
    expect(servers.guarded?.url).toBe("https://mcp.guarded.example/mcp");
    expect(result.notices).toEqual(
      expect.arrayContaining([
        "models proxied: providers.proxied.baseUrl carried user credentials; add a credentials.rules header rule",
        "models proxied: providers.proxied.models[0].baseUrl carried user credentials; add a credentials.rules header rule",
        "mcp guarded: mcpServers.guarded.url carried user credentials; add a credentials.rules header rule",
      ]),
    );
    expect(result.rules.filter((rule) => rule.id.includes("userinfo"))).toEqual([]);
    expect(servers.guarded?.headers).toBeUndefined();
    expect(rulesOf(result.rules, "derived:mcp:guarded:oauth")).toEqual([]);
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

describe("deriveSandboxPi fix round", () => {
  const mcpOnly = (mcpServers: Record<string, unknown>) =>
    deriveSandboxPi(input({ files: { agentDir: AGENT_DIR, mcp: { mcpServers } } }));

  const serverOf = (result: ReturnType<typeof deriveSandboxPi>, name: string) =>
    (result.files["mcp.json"].mcpServers as Record<string, Record<string, unknown>>)[name];

  it("adds no OAuth bearer to a server that authenticates with its own credential header", () => {
    const result = mcpOnly({
      keyed: { url: "https://mcp.keyed.example/mcp", headers: { "X-Api-Key": "LITERAL" } },
    });

    expect(serverOf(result, "keyed")?.headers).toEqual({ "X-Api-Key": P("mcp:keyed:header:x-api-key") });
    expect(rulesOf(result.rules, "derived:mcp:keyed:oauth")).toEqual([]);
  });

  it.each([
    [{ "X-Trace": "2" }, true],
    [{ "X-Api-Version": "2" }, true],
    [{ "X-Access-Region": "eu" }, true],
    [{ "X-Session-Mode": "fast" }, true],
    [{ "X-Api-Key": "abc" }, false],
    [{ "X-Session-Id": "abc" }, false],
    [{ Authorization: "x" }, false],
    [{ Cookie: "a=b" }, false],
    [{ "X-Auth-Token": "x" }, false],
    [{ "X-Tenant": "$TENANT" }, false],
    [{ "X-Signed": "!sign" }, false],
    [{ "X-Upstream": "Bearer x" }, false],
  ])(
    "gives the server headers %o an OAuth bearer: %s, exactly when no header is bound as a credential",
    (headers, oauth) => {
      const result = mcpOnly({ srv: { url: "https://mcp.srv.example/mcp", headers } });
      const bound = result.rules.some((rule) => rule.id.startsWith("derived:mcp:srv:header:"));

      expect(rulesOf(result.rules, "derived:mcp:srv:oauth").length > 0).toBe(oauth);
      expect(bound || ["X-Tenant", "X-Signed"].some((name) => name in headers)).toBe(!oauth);
    },
  );

  it("merges header names that differ only in case, the last one winning", () => {
    const result = mcpOnly({
      srv: { url: "https://mcp.srv.example/mcp", headers: { "X-Api-Key": "FIRST", "x-api-key": "LAST" } },
    });
    const rules = rulesOf(result.rules, "derived:mcp:srv:header:x-api-key");

    expect(serverOf(result, "srv")?.headers).toEqual({ "x-api-key": P("mcp:srv:header:x-api-key") });
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({
      header: "x-api-key",
      secret: { pointer: "/mcpServers/srv/headers/x-api-key" },
    });
  });

  it("binds a literal credential-shaped value under any header name", () => {
    const result = mcpOnly({
      srv: { url: "https://mcp.srv.example/mcp", headers: { "X-Upstream": "Bearer LIT-UPSTREAM" } },
    });

    expect(JSON.stringify(result.files["mcp.json"])).not.toContain("LIT-UPSTREAM");
    expect(rulesOf(result.rules, "derived:mcp:srv:header:x-upstream")).toHaveLength(1);
  });

  it("adds no OAuth bearer to a server whose name host pi cannot sign in to", () => {
    const result = mcpOnly({ "dotted.name": { url: "https://mcp.dot.example/mcp" } });

    expect(serverOf(result, "dotted.name")).toEqual({ url: "https://mcp.dot.example/mcp" });
    expect(result.rules.filter((rule) => rule.id.startsWith("derived:mcp:"))).toEqual([]);
  });

  it("binds an unbraced variable inside a credential header as pi interpolates it", () => {
    const models = {
      providers: {
        gw: {
          baseUrl: "https://gw.example/v1",
          headers: { Authorization: "Bearer $GW_TOKEN", "X-Price": "$$5", "X-Escaped-Key": "a$$b" },
        },
      },
    };
    const result = deriveSandboxPi(input({ files: { agentDir: AGENT_DIR, models } }));
    const headers = (result.files["models.json"].providers as Record<string, Record<string, unknown>>).gw
      ?.headers;
    const placeholder = P("models:gw:header:authorization");

    expect(headers).toEqual({
      Authorization: `Bearer ${placeholder}`,
      "X-Price": "$$5",
      "X-Escaped-Key": P("models:gw:header:x-escaped-key"),
    });
    expect(rulesOf(result.rules, "derived:models:gw:header:authorization")).toEqual([
      {
        id: "derived:models:gw:header:authorization",
        host: "gw.example",
        placeholder,
        header: "Authorization",
        template: "Bearer {secret}",
        secret: { env: "GW_TOKEN" },
      },
    ]);
    expect(rulesOf(result.rules, "derived:models:gw:header:x-escaped-key")).toEqual([]);
    expect(result.notices.some((notice) => notice.startsWith("models gw: header X-Escaped-Key"))).toBe(true);
  });

  const JWT_VALUE = `${["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxIn0", "c2ln"].join(".")}`;

  it.each([
    ["AUTHORIZATION", "Bearer FAKE-live-1"],
    ["PASSPHRASE", "FAKE-hunter2"],
    ["SENTRY_JWT", JWT_VALUE],
    ["GH_PAT", "FAKE-pat"],
    ["DB_PASS", "FAKE-pass"],
    ["clientSecret", "FAKE-camel"],
    ["ACCESSTOKEN", "FAKE-fused"],
    ["ENCRYPTION_KEY", "FAKE-key"],
    ["SENTRY_DSN", "FAKE-dsn"],
    ["SESSION_COOKIE", "FAKE-cookie"],
    ["UPSTREAM", "Basic RkFLRTpGQUtF"],
    ["CONFIG", JWT_VALUE],
    ["DATABASE_URL", "postgres://u:FAKE-url@db.example/app"],
  ])("puts a placeholder in the stdio env %s", (variable, value) => {
    const result = mcpOnly({ s: { command: "srv", env: { [variable]: value } } });

    expect(serverOf(result, "s")?.env).toEqual({ [variable]: P(`mcp:s:env:${variable}`) });
  });

  it.each([
    ["PASS_THROUGH", "1"],
    ["AUTH_MODE", "oauth"],
    ["MAX_TOKENS", "4096"],
    ["TOKEN_FILE", "/run/token"],
    ["SESSION_DIR", "/tmp/s"],
    ["API_KEY_PATH", "/etc/key"],
    ["USE_TOKEN", "true"],
    ["TOKENIZER", "bert"],
    ["KEY_ID", "k-1"],
    ["PWD", "/work"],
    ["PATH", "/usr/bin"],
    ["AUTHOR", "me"],
    ["API_TOKEN", ""],
  ])("keeps the stdio env %s", (variable, value) => {
    const result = mcpOnly({ s: { command: "srv", env: { [variable]: value } } });

    expect(serverOf(result, "s")?.env).toEqual({ [variable]: value });
  });

  it("puts placeholders in secret flag values and leaves ordinary flags alone", () => {
    const args = [
      "srv.js",
      "--max-tokens",
      "4096",
      "--no-auth",
      "server.js",
      "--session-dir",
      "/tmp/s",
      "--token",
      "FAKE-next",
      "--api-key=FAKE-inline",
      "--password=1234",
      "--verbose",
      "true",
      `--upstream=https://u:FAKE-userinfo@db.example/x`,
      JWT_VALUE,
    ];
    const result = mcpOnly({ cli: { command: "node", args } });

    expect(JSON.stringify(result.files["mcp.json"])).not.toContain("FAKE");
    expect(serverOf(result, "cli")?.args).toEqual([
      "srv.js",
      "--max-tokens",
      "4096",
      "--no-auth",
      "server.js",
      "--session-dir",
      "/tmp/s",
      "--token",
      P("mcp:cli:arg:8"),
      `--api-key=${P("mcp:cli:arg:9")}`,
      "--password=1234",
      "--verbose",
      "true",
      `--upstream=${P("mcp:cli:arg:13")}`,
      P("mcp:cli:arg:14"),
    ]);
  });

  it("copies only primitive non-secret fields of an OAuth entry", () => {
    const auth = {
      jwt: {
        type: "oauth",
        access: JWT_ACCESS,
        refresh: SECRETS.refresh,
        expires: 1,
        accountId: "account-7",
        extra: { id_token: SECRETS.idToken },
        list: [SECRETS.idToken],
      },
    };
    const result = deriveSandboxPi(input({ files: { agentDir: AGENT_DIR, auth } }));
    const entry = result.files["auth.json"].jwt as Record<string, unknown>;

    expect(Object.keys(entry).sort()).toEqual(["access", "accountId", "expires", "refresh", "type"]);
    expect(JSON.stringify(result.files)).not.toContain(SECRETS.idToken);
  });
});

describe("deriveSandboxPi fix wave", () => {
  it("copies a credential's env, with placeholders for secret names and credential shapes", () => {
    const auth = {
      keyed: { type: "api_key", key: SECRETS.apiKey, env: { ACCOUNT_ID: "acct-1", GATEWAY_TOKEN: "x-real" } },
      jwt: {
        type: "oauth",
        access: JWT_ACCESS,
        refresh: SECRETS.refresh,
        expires: 1,
        env: { AUTH: `Bearer ${SECRETS.idToken}` },
      },
    };
    const result = deriveSandboxPi(input({ files: { agentDir: AGENT_DIR, auth } }));

    expect(result.files["auth.json"].keyed).toEqual({
      type: "api_key",
      key: P("auth:keyed:key"),
      env: { ACCOUNT_ID: "acct-1", GATEWAY_TOKEN: P("auth:keyed:env:GATEWAY_TOKEN") },
    });
    expect((result.files["auth.json"].jwt as Record<string, unknown>).env).toEqual({
      AUTH: P("auth:jwt:env:AUTH"),
    });
    expect(JSON.stringify(result.files)).not.toMatch(/x-real/);
  });

  it("gives a disabled HTTP MCP server no rule and no sign-in, and a provider-auth server the provider's credential", () => {
    const mcp = {
      mcpServers: {
        off: { url: "https://off.example/mcp", enabled: false, headers: { "X-Api-Key": "OFF-REAL-KEY" } },
        prov: { url: "https://prov.example/mcp", auth: { provider: "keyed" } },
        lost: { url: "https://lost.example/mcp", auth: { provider: "nowhere" } },
        signed: { url: "https://signed.example/mcp" },
      },
    };
    const result = deriveSandboxPi(input({ files: { agentDir: AGENT_DIR, auth: hostAuth(), mcp } }));
    const servers = result.files["mcp.json"].mcpServers as Record<string, Record<string, unknown>>;

    expect(result.rules.filter((rule) => rule.host === "off.example")).toEqual([]);
    expect(JSON.stringify(servers.off)).not.toContain("OFF-REAL-KEY");
    expect(servers.prov).toEqual({ url: "https://prov.example/mcp", auth: { provider: "keyed" } });
    expect(rulesOf(result.rules, "derived:mcp:prov:auth")).toEqual([
      {
        id: "derived:mcp:prov:auth",
        host: "prov.example",
        placeholder: P("auth:keyed:key"),
        secret: { piAuth: "keyed" },
      },
    ]);
    expect(result.rules.filter((rule) => rule.host === "lost.example")).toEqual([]);
    expect(result.notices).toContain("mcp lost: auth.provider nowhere has no host credential, so no rule");
    expect(result.oauthServers).toEqual([{ name: "signed", url: "https://signed.example/mcp" }]);
  });

  it("names absolute stdio command and cwd paths, which the sandbox may not have", () => {
    const mcp = {
      mcpServers: {
        local: { command: "/opt/homebrew/bin/uvx", cwd: "/Users/me/x", args: [] },
        npx: { command: "npx" },
      },
    };
    const result = deriveSandboxPi(input({ files: { agentDir: AGENT_DIR, mcp } }));

    expect(result.notices).toEqual(
      expect.arrayContaining([
        "mcp local: command /opt/homebrew/bin/uvx is a host path, which the sandbox may not have",
        "mcp local: cwd /Users/me/x is a host path, which the sandbox may not have",
      ]),
    );
    expect(result.notices.some((notice) => notice.startsWith("mcp npx:"))).toBe(false);
  });

  it("names registry hosts that have neither a credential rule nor an egress entry", () => {
    const registries = [
      { label: "npmrc", endpoint: { host: "npm.corp.example" } },
      { label: "maven", endpoint: { host: "nexus.corp.example", port: 8443 } },
      { label: "pip", endpoint: { host: "pypi.org" } },
      { label: "npmrc", endpoint: { host: "api.keyed.example" } },
    ];
    const tools = {
      value: { gh: [], glab: [], maven: { servers: [], mirrors: [], passthrough: [] }, git: {}, env: {} },
      rules: [],
      notices: [],
      registries,
    };
    const notices = deriveSandboxPi(input({ tools, egress: ["pypi.org", "nexus.corp.example"] })).notices;

    expect(notices).toContain(
      'npmrc: npm.corp.example has no credential rule and is not in the egress allowlist; add "npm.corp.example" to egress.allow to reach it',
    );
    expect(notices).toContain(
      'maven: nexus.corp.example:8443 has no credential rule and is not in the egress allowlist; add "nexus.corp.example:8443" to egress.allow to reach it',
    );
    expect(notices.filter((notice) => notice.includes("egress.allow"))).toHaveLength(2);
    expect(deriveSandboxPi(input({ tools })).notices.some((notice) => notice.includes("egress.allow"))).toBe(
      false,
    );
  });
});
