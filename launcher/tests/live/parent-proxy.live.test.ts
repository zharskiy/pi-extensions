import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type InspectingProxy, startInspectingProxy } from "./fixtures/inspecting-proxy.ts";
import { type LlmFixture, startLlmFixture } from "./fixtures/llm-fixture.ts";
import { type McpFixture, startMcpFixture } from "./fixtures/mcp-fixture.ts";
import { createTestCa } from "./fixtures/test-ca.ts";
import { FIXTURE_HOSTS, LOOPBACK } from "./harness/names.ts";
import { createLiveSandbox, type LiveSandbox, liveEnabled } from "./harness/sandbox.ts";
import {
  fixtureConfig,
  MODEL_ARGS,
  providerModels,
  providerSettings,
  randomSecret,
} from "./harness/scenario.ts";

const REPLY = "reply that crossed the inspecting parent proxy";

const TOOL = "parent_proxy_fixture_tool";

describe.skipIf(!liveEnabled)("behind a TLS-inspecting parent proxy with tls.extraCa (live)", () => {
  const apiKey = randomSecret("fixture-provider-key");
  const token = randomSecret("fixture-mcp-token");
  const credentials = { user: "corp-user", password: randomSecret("fixture-parent-password") };
  const state: { sandbox?: LiveSandbox; llm?: LlmFixture; mcp?: McpFixture; parent?: InspectingProxy } = {};

  beforeAll(async () => {
    const sandbox = await createLiveSandbox("parent-proxy");
    const parentDir = join(sandbox.root, "parent-ca");

    state.sandbox = sandbox;

    await mkdir(parentDir, { recursive: true });

    const parentCa = await createTestCa(parentDir, "inspecting-ca");

    state.parent = await startInspectingProxy({
      ca: parentCa,
      upstreamCa: sandbox.ca.certPem,
      credentials,
      resolve: () => LOOPBACK,
    });

    state.llm = await startLlmFixture(sandbox.certificate, apiKey, () => ({ text: REPLY }));

    state.mcp = await startMcpFixture(sandbox.certificate, {
      tool: TOOL,
      authorize: (seen) => seen === token,
    });

    const credentialsFile = await sandbox.writeFile(
      "parent-credentials.json",
      JSON.stringify({ basic: `${credentials.user}:${credentials.password}` }),
    );

    await sandbox.writeAgentFile("models.json", providerModels(state.llm.baseUrl(FIXTURE_HOSTS.llm), apiKey));

    await sandbox.writeAgentFile("settings.json", providerSettings());

    await sandbox.writeAgentFile("mcp.json", {
      mcpServers: {
        fixture: {
          url: state.mcp.endpoint(FIXTURE_HOSTS.mcp),
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    });

    await sandbox.writeUserConfig(fixtureConfig(sandbox, { extraCa: [parentCa.certPath] }));

    const prebuild = await sandbox.pi(["mcp", "list"]).done;

    expect(prebuild.code).toBe(0);

    state.llm.seen.splice(0);

    state.mcp.seen.splice(0);

    await sandbox.writeUserConfig(
      fixtureConfig(sandbox, {
        extraCa: [parentCa.certPath],
        egress: {
          parentProxy: { url: state.parent.url, auth: { file: credentialsFile, pointer: "/basic" } },
        },
      }),
    );
  }, 600_000);

  afterAll(async () => {
    await state.llm?.close();

    await state.mcp?.close();

    await state.parent?.close();

    await state.sandbox?.cleanup();
  }, 120_000);

  it("sends every upstream connection through the authenticated parent proxy", async () => {
    const sandbox = state.sandbox as LiveSandbox;
    const parent = state.parent as InspectingProxy;
    const prompt = await sandbox.pi(["-p", "say hello", ...MODEL_ARGS]).done;
    const list = await sandbox.pi(["mcp", "list"]).done;

    expect(prompt.code).toBe(0);

    expect(prompt.stdout).toContain(REPLY);

    expect(list.code).toBe(0);

    expect(list.stdout).toContain(TOOL);

    expect(new Set(state.llm?.authorizations())).toEqual(new Set([`Bearer ${apiKey}`]));

    expect(new Set(state.mcp?.tokens())).toEqual(new Set([token]));

    const tunnelled = new Set(
      parent.tunnels.filter((tunnel) => tunnel.authorized).map((tunnel) => tunnel.host),
    );
    const reached = new Set(
      [...(state.llm?.seen ?? []), ...(state.mcp?.seen ?? [])].map((request) => request.host),
    );

    expect(tunnelled).toEqual(new Set([FIXTURE_HOSTS.llm, FIXTURE_HOSTS.mcp]));

    expect([...reached].every((host) => tunnelled.has(host))).toBe(true);
  });
});
