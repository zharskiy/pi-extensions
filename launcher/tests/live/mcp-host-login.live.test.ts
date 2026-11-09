import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mcpAuthKey } from "../../shared/index.ts";
import { type McpFixture, startMcpFixture } from "./fixtures/mcp-fixture.ts";
import { FIXTURE_HOSTS } from "./harness/names.ts";
import { createLiveSandbox, type LiveSandbox, liveEnabled } from "./harness/sandbox.ts";
import { fixtureConfig, randomSecret } from "./harness/scenario.ts";
import { sweepSandbox } from "./harness/sweep.ts";

const TOOL = "host_login_fixture_tool";

const SERVER = "host-login";

const HOUR_MS = 3_600_000;

const SIGN_IN_TEXT = `pi-sandbox: sign-in to MCP server ${SERVER} opened in the browser on the host; finish it there, then retry. If no browser opened, run pi mcp login ${SERVER} on the host.`;

const FETCH_SCRIPT = [
  "const [url, authorization] = process.argv.slice(1);",
  "fetch(url, { method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: '{}' }).then(",
  "  async (response) => console.log(JSON.stringify({ status: response.status, body: await response.text() })),",
  "  (error) => console.log(JSON.stringify({ status: 0, body: String(error) })),",
  ");",
].join("\n");

const quoted = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

const renderedAuthorization = async (sandbox: LiveSandbox) => {
  const rendered = await sandbox.exec("cat ~/.pi/agent/mcp.json");
  const servers = (
    JSON.parse(rendered.stdout) as { mcpServers: Record<string, { headers?: Record<string, string> }> }
  ).mcpServers;

  return servers[SERVER]?.headers?.Authorization ?? "";
};

describe.skipIf(!liveEnabled)("MCP sign-in owned by the host pi (live)", () => {
  const access = randomSecret("fixture-mcp-access");
  const state: { sandbox?: LiveSandbox; mcp?: McpFixture; url: string } = { url: "" };

  const writeHostSignIn = (expiresAt: number) =>
    (state.sandbox as LiveSandbox).writeAgentFile("mcp-auth.json", {
      [mcpAuthKey(SERVER, state.url)]: {
        tokens: { access_token: access, token_type: "Bearer" },
        tokensExpireAt: expiresAt,
      },
    });

  beforeAll(async () => {
    const sandbox = await createLiveSandbox("mcp-host-login");

    state.sandbox = sandbox;

    state.mcp = await startMcpFixture(sandbox.certificate, {
      tool: TOOL,
      authorize: (token) => token === access,
    });

    state.url = state.mcp.endpoint(FIXTURE_HOSTS.oauthMcp);

    await sandbox.writeAgentFile("mcp.json", { mcpServers: { [SERVER]: { url: state.url } } });

    await sandbox.writeUserConfig(fixtureConfig(sandbox));
  }, 120_000);

  afterAll(async () => {
    await state.mcp?.close();

    await state.sandbox?.cleanup();
  }, 120_000);

  it("answers 503 with the sign-in text and sends nothing upstream while the host sign-in has expired", async () => {
    const sandbox = state.sandbox as LiveSandbox;

    await writeHostSignIn(Date.now() - HOUR_MS);

    expect((await sandbox.pi(["--version"]).done).code).toBe(0);

    const authorization = await renderedAuthorization(sandbox);
    const reply = await sandbox.exec(
      `node -e ${quoted(FETCH_SCRIPT)} ${quoted(state.url)} ${quoted(authorization)}`,
    );

    expect(JSON.parse(reply.stdout)).toEqual({ status: 503, body: SIGN_IN_TEXT });

    expect(state.mcp?.tokens()).toEqual([]);
  });

  it("injects the host's token into the container's requests once the host is signed in", async () => {
    const sandbox = state.sandbox as LiveSandbox;

    await writeHostSignIn(Date.now() + HOUR_MS);

    const result = await sandbox.pi(["mcp", "list"]).done;

    expect(result.code).toBe(0);

    expect(result.stdout).toContain(TOOL);

    expect(new Set(state.mcp?.tokens())).toEqual(new Set([access]));

    expect(await renderedAuthorization(sandbox)).toMatch(/^Bearer pi-sandbox-[0-9a-f]{24}$/);

    expect((await sweepSandbox(sandbox, { access })).findings).toEqual([]);
  });
});
