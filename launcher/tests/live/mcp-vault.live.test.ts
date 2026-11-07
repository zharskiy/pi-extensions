import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isPlaceholder } from "../../shared/index.ts";
import { followRedirects } from "./fixtures/browser.ts";
import { type LlmFixture, type Script, startLlmFixture, toolResults } from "./fixtures/llm-fixture.ts";
import { type McpFixture, startMcpFixture } from "./fixtures/mcp-fixture.ts";
import { type ClientAuth, type OAuthFixture, startOAuthFixture } from "./fixtures/oauth-fixture.ts";
import { ALL_FIXTURE_HOSTS, FIXTURE_HOSTS, LOOPBACK } from "./harness/names.ts";
import { createLiveSandbox, type LiveSandbox, liveEnabled, type PiResult } from "./harness/sandbox.ts";
import {
  authority,
  fixtureConfig,
  MODEL_ARGS,
  providerModels,
  providerSettings,
  randomSecret,
  waitFor,
} from "./harness/scenario.ts";
import { sweepSandbox } from "./harness/sweep.ts";

const TOOL = "vault_fixture_tool";

const SERVER = "vault-fixture";

const ACCESS_LIFETIME_SECONDS = Number(process.env.PI_SANDBOX_LIVE_OAUTH_LIFETIME ?? "60");

const LOGIN_TIMEOUT_SECONDS = 150;

const OPEN_WAIT_MS = 120_000;

const LOOPBACK_REDIRECT = /^http:\/\/(127\.0\.0\.1|localhost):\d+\//;

const SIGN_IN_REQUIRED = `MCP server "${SERVER}" requires sign-in. Run /mcp`;

const SECRET_TOKEN_FIELDS = ["access_token", "refresh_token", "id_token"];

const OTHER_AUTHORIZE_URL =
  "https://other.fixtures.test/authorize?response_type=code&client_id=fixture&code_challenge=abc&code_challenge_method=S256&redirect_uri=http%3A%2F%2F127.0.0.1%3A40000%2Fcallback&state=fixture";

interface ServerFixtures {
  name: string;
  oauth: OAuthFixture;
  mcp: McpFixture;
}

interface Login {
  url: string;
  callback?: { status: number; body: string };
  result: PiResult;
}

type AuthFile = Record<
  string,
  { serverUrl?: string; tokens?: Record<string, unknown>; clientInformation?: Record<string, unknown> }
>;

const resolveFixture = (host: string) => (ALL_FIXTURE_HOSTS.includes(host) ? LOOPBACK : undefined);

const startServer = async (
  sandbox: LiveSandbox,
  name: string,
  tool: string,
  clientAuth: ClientAuth,
): Promise<ServerFixtures> => {
  const oauth = await startOAuthFixture(sandbox.certificate, FIXTURE_HOSTS.auth, ACCESS_LIFETIME_SECONDS, {
    clientAuth,
  });
  const mcp = await startMcpFixture(sandbox.certificate, {
    tool,
    authorize: (token) => oauth.isValidAccess(token),
    authorizationServer: () => oauth.issuer(FIXTURE_HOSTS.auth),
  });

  return { name, oauth, mcp };
};

const closeServer = async (server: ServerFixtures | undefined) => {
  await server?.mcp.close();

  await server?.oauth.close();
};

const vaultSecrets = (oauth: OAuthFixture) =>
  Object.fromEntries(
    [...oauth.issuedAccess(), ...oauth.issuedRefresh(), ...oauth.issuedCodes(), ...oauth.issuedSecrets()].map(
      (value) => [value, value],
    ),
  );

const loginInside = async (sandbox: LiveSandbox, server: string): Promise<Login> => {
  const before = (await sandbox.openedUrls()).length;
  const finished: { result?: PiResult } = {};
  const login = sandbox.exec(`timeout ${LOGIN_TIMEOUT_SECONDS} pi mcp login ${server} 2>&1`);

  void login.then((result) => {
    finished.result = result;
  });

  const url = await waitFor(async () => {
    const opened = await sandbox.openedUrls();

    return opened[before] ?? (finished.result === undefined ? undefined : "");
  }, OPEN_WAIT_MS);

  if (url === "") {
    const failed = await login;

    console.log(`login without an opened URL: exit ${failed.code}\n${failed.stdout}${failed.stderr}`);

    return { url, result: failed };
  }

  const callback = await followRedirects(url, sandbox.ca.certPem, resolveFixture);
  const result = await login;

  console.log(
    `$ pi mcp login ${server} (in the container)\nexit ${result.code}\n${result.stdout}${result.stderr}`,
  );

  return { url, callback, result };
};

const readContainerAuth = async (sandbox: LiveSandbox): Promise<AuthFile> => {
  const file = await sandbox.exec("cat ~/.pi/agent/mcp-auth.json");

  expect(file.code).toBe(0);

  return JSON.parse(file.stdout) as AuthFile;
};

const entryFor = (auth: AuthFile, server: ServerFixtures) =>
  Object.values(auth).find((entry) => entry.serverUrl === server.mcp.endpoint(FIXTURE_HOSTS.oauthMcp));

const secretTokensOf = (entry: AuthFile[string] | undefined) =>
  Object.fromEntries(SECRET_TOKEN_FIELDS.map((field) => [field, entry?.tokens?.[field]]));

const secretFieldsOf = (auth: AuthFile) =>
  Object.values(auth).flatMap((entry) => [
    ...SECRET_TOKEN_FIELDS.map((field) => entry.tokens?.[field]),
    entry.clientInformation?.client_secret,
  ]);

const expectOnlyPlaceholders = (auth: AuthFile) => {
  const values = secretFieldsOf(auth).filter((value) => value !== undefined);

  values.forEach((value) => {
    expect(typeof value === "string" && isPlaceholder(value), `${String(value)} is a placeholder`).toBe(true);
  });
};

const expectCleanSweep = async (sandbox: LiveSandbox, oauth: OAuthFixture) => {
  const { findings } = await sweepSandbox(sandbox, vaultSecrets(oauth));

  expect(findings).toEqual([]);
};

const expectSignedIn = (login: Login, oauth: OAuthFixture) => {
  const opened = new URL(login.url);

  expect(opened.host).toBe(authority(FIXTURE_HOSTS.auth, oauth.port));

  expect(opened.searchParams.get("redirect_uri")).toMatch(LOOPBACK_REDIRECT);

  expect(login.callback?.status).toBe(200);

  expect(login.result.code).toBe(0);

  expect(login.result.stdout).toContain("Signed in to MCP server");
};

const toolScript =
  (onToolCall: () => void): Script =>
  (request) => {
    const results = toolResults(request);

    if (results.length > 0) {
      return { text: results.join("\n") };
    }

    const tool = request.tools?.find((candidate) => candidate.function.name.endsWith(TOOL));

    if (tool === undefined) {
      return { text: "no MCP tool was offered" };
    }

    onToolCall();

    return { tool: { name: tool.function.name, arguments: {} } };
  };

describe.skipIf(!liveEnabled)("MCP token vault: sign-in inside the container (live)", () => {
  const llmKey = randomSecret("fixture-llm-key");
  const state: { sandbox?: LiveSandbox; server?: ServerFixtures; llm?: LlmFixture; placeholders?: unknown } =
    {};

  beforeAll(async () => {
    const sandbox = await createLiveSandbox("mcp-vault");

    state.sandbox = sandbox;

    state.server = await startServer(sandbox, SERVER, TOOL, "none");

    state.llm = await startLlmFixture(
      sandbox.certificate,
      llmKey,
      toolScript(() => state.server?.oauth.revokeAll()),
    );

    await sandbox.writeAgentFile("mcp.json", {
      mcpServers: {
        [SERVER]: { url: state.server.mcp.endpoint(FIXTURE_HOSTS.oauthMcp), exposure: "direct" },
      },
    });

    await sandbox.writeAgentFile("models.json", providerModels(state.llm.baseUrl(FIXTURE_HOSTS.llm), llmKey));

    await sandbox.writeAgentFile("settings.json", providerSettings());

    await sandbox.writeUserConfig(fixtureConfig(sandbox));

    const first = await sandbox.pi(["mcp", "list"]).done;

    expect(first.stdout).toContain("needs sign-in");
  }, 600_000);

  afterAll(async () => {
    await closeServer(state.server);

    await state.llm?.close();

    await state.sandbox?.cleanup();
  }, 120_000);

  it("signs in with pi mcp login inside the container through the host browser", async () => {
    const sandbox = state.sandbox as LiveSandbox;
    const { oauth } = state.server as ServerFixtures;
    const login = await loginInside(sandbox, SERVER);

    expectSignedIn(login, oauth);

    expect(login.result.stdout).toContain(login.url);

    expect(oauth.grants()).toEqual(["authorization_code"]);
  }, 300_000);

  it("keeps every issued token, code and client secret out of the container", async () => {
    const sandbox = state.sandbox as LiveSandbox;
    const { oauth } = state.server as ServerFixtures;
    const auth = await readContainerAuth(sandbox);
    const entry = entryFor(auth, state.server as ServerFixtures);

    expect(entry?.tokens?.access_token).toBeTypeOf("string");

    expect(entry?.clientInformation?.client_secret).toBeUndefined();

    expectOnlyPlaceholders(auth);

    state.placeholders = secretTokensOf(entry);

    await expectCleanSweep(sandbox, oauth);
  }, 300_000);

  it("lists the tool with the real token injected by the proxy", async () => {
    const sandbox = state.sandbox as LiveSandbox;
    const { oauth, mcp } = state.server as ServerFixtures;
    const result = await sandbox.pi(["mcp", "list"]).done;

    expect(result.code).toBe(0);

    expect(result.stdout).toContain(TOOL);

    expect(mcp.tokens().at(-1)).toBe(oauth.issuedAccess().at(-1));
  }, 300_000);

  it(
    "keeps working after the access token expires, refreshed on the host",
    async () => {
      const sandbox = state.sandbox as LiveSandbox;
      const { oauth, mcp } = state.server as ServerFixtures;
      const expiring = oauth.issuedAccess().at(-1) ?? "";

      await waitFor(
        () => (oauth.isValidAccess(expiring) ? undefined : true),
        (ACCESS_LIFETIME_SECONDS + 30) * 1000,
      );

      const result = await sandbox.pi(["mcp", "list"]).done;

      expect(result.code).toBe(0);

      expect(result.stdout).toContain(TOOL);

      expect(oauth.grants()).toContain("refresh_token");

      expect(oauth.isValidAccess(mcp.tokens().at(-1) ?? "")).toBe(true);

      const auth = await readContainerAuth(sandbox);

      expect(secretTokensOf(entryFor(auth, state.server as ServerFixtures))).toEqual(state.placeholders);

      expectOnlyPlaceholders(auth);

      await expectCleanSweep(sandbox, oauth);
    },
    (ACCESS_LIFETIME_SECONDS + 300) * 1000,
  );

  it("asks for a sign-in after revocation and signs in again with the stored client", async () => {
    const sandbox = state.sandbox as LiveSandbox;
    const { oauth } = state.server as ServerFixtures;
    const prompt = await sandbox.pi(["-p", `Call the ${TOOL} tool and report its answer.`, ...MODEL_ARGS])
      .done;

    expect(prompt.stdout).toContain(SIGN_IN_REQUIRED);

    const login = await loginInside(sandbox, SERVER);

    expectSignedIn(login, oauth);

    expect(oauth.grants().filter((grant) => grant === "authorization_code")).toHaveLength(2);

    expect(oauth.seen.filter((request) => request.path === "/register")).toHaveLength(1);

    expectOnlyPlaceholders(await readContainerAuth(sandbox));

    await expectCleanSweep(sandbox, oauth);
  }, 600_000);

  it("refuses to open a URL that is not a configured authorization endpoint", async () => {
    const sandbox = state.sandbox as LiveSandbox;
    const before = await sandbox.openedUrls();
    const other = await sandbox.exec(`xdg-open '${OTHER_AUTHORIZE_URL}'`);
    const malformed = await sandbox.exec("xdg-open not-a-url");

    expect(other.code).toBe(1);

    expect(other.stderr).toContain("pi-sandbox:");

    expect(malformed.code).toBe(3);

    expect(await sandbox.openedUrls()).toEqual(before);
  }, 120_000);

  it("answers a sign-in while already signed in without a new flow", async () => {
    const sandbox = state.sandbox as LiveSandbox;
    const { oauth } = state.server as ServerFixtures;
    const before = await sandbox.openedUrls();
    const result = await sandbox.exec(`timeout ${LOGIN_TIMEOUT_SECONDS} pi mcp login ${SERVER} 2>&1`);

    expect(result.code).toBe(0);

    expect(result.stdout).toContain(`Already signed in to MCP server "${SERVER}"`);

    expect(await sandbox.openedUrls()).toEqual(before);

    expect(oauth.grants().filter((grant) => grant === "authorization_code")).toHaveLength(2);
  }, 300_000);
});

describe.skipIf(!liveEnabled)("MCP token vault: confidential DCR clients (live)", () => {
  const variants: Array<{ name: string; tool: string; clientAuth: ClientAuth }> = [
    { name: "vault-basic", tool: "vault_basic_tool", clientAuth: "client_secret_basic" },
    { name: "vault-post", tool: "vault_post_tool", clientAuth: "client_secret_post" },
  ];
  const state: { sandbox?: LiveSandbox; servers: ServerFixtures[] } = { servers: [] };

  beforeAll(async () => {
    const sandbox = await createLiveSandbox("mcp-vault-confidential");

    state.sandbox = sandbox;

    state.servers = await Promise.all(
      variants.map((variant) => startServer(sandbox, variant.name, variant.tool, variant.clientAuth)),
    );

    await sandbox.writeAgentFile("mcp.json", {
      mcpServers: Object.fromEntries(
        state.servers.map((server) => [server.name, { url: server.mcp.endpoint(FIXTURE_HOSTS.oauthMcp) }]),
      ),
    });

    await sandbox.writeUserConfig(fixtureConfig(sandbox));

    const first = await sandbox.pi(["mcp", "list"]).done;

    expect(first.stdout).toContain("needs sign-in");
  }, 600_000);

  afterAll(async () => {
    await Promise.all(state.servers.map(closeServer));

    await state.sandbox?.cleanup();
  }, 120_000);

  it.each(variants)(
    "signs in a $clientAuth client and keeps its secret on the host",
    async (variant) => {
      const sandbox = state.sandbox as LiveSandbox;
      const server = state.servers.find((candidate) => candidate.name === variant.name) as ServerFixtures;
      const login = await loginInside(sandbox, variant.name);

      expectSignedIn(login, server.oauth);

      expect(server.oauth.grants()).toEqual(["authorization_code"]);

      expect(server.oauth.issuedSecrets()).toHaveLength(1);

      const auth = await readContainerAuth(sandbox);
      const secret = entryFor(auth, server)?.clientInformation?.client_secret;

      expect(typeof secret === "string" && isPlaceholder(secret)).toBe(true);

      expectOnlyPlaceholders(auth);

      await expectCleanSweep(sandbox, server.oauth);
    },
    300_000,
  );
});
