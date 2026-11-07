import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type McpFixture, startMcpFixture } from "./fixtures/mcp-fixture.ts";
import { FIXTURE_HOSTS } from "./harness/names.ts";
import { createLiveSandbox, type LiveSandbox, liveEnabled } from "./harness/sandbox.ts";
import { fixtureConfig, randomSecret } from "./harness/scenario.ts";

const TOOL = "bearer_fixture_tool";

describe.skipIf(!liveEnabled)("HTTP MCP server with a bearer token (live)", () => {
  const token = randomSecret("fixture-mcp-token");
  const state: { sandbox?: LiveSandbox; mcp?: McpFixture } = {};

  beforeAll(async () => {
    const sandbox = await createLiveSandbox("mcp-bearer");

    state.sandbox = sandbox;

    state.mcp = await startMcpFixture(sandbox.certificate, {
      tool: TOOL,
      authorize: (seen) => seen === token,
    });

    await sandbox.writeAgentFile("mcp.json", {
      mcpServers: {
        fixture: {
          url: state.mcp.endpoint(FIXTURE_HOSTS.mcp),
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    });

    await sandbox.writeUserConfig(fixtureConfig(sandbox));
  }, 120_000);

  afterAll(async () => {
    await state.mcp?.close();

    await state.sandbox?.cleanup();
  }, 120_000);

  it("lists the tool through the proxy, which sent the real token", async () => {
    const sandbox = state.sandbox as LiveSandbox;
    const mcp = state.mcp as McpFixture;
    const result = await sandbox.pi(["mcp", "list"]).done;

    expect(result.code).toBe(0);

    expect(result.stdout).toContain(TOOL);

    expect(mcp.tokens().length).toBeGreaterThan(0);

    expect(new Set(mcp.tokens())).toEqual(new Set([token]));

    const config = await sandbox.exec("cat ~/.pi/agent/mcp.json");

    expect(config.stdout).toContain(mcp.endpoint(FIXTURE_HOSTS.mcp));

    expect(config.stdout).not.toContain(token);
  });
});
