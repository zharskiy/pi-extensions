import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type HttpsFixture, sendJson, startHttpsFixture } from "./fixtures/https-fixture.ts";
import { FIXTURE_HOSTS } from "./harness/names.ts";
import { createLiveSandbox, type LiveSandbox, liveEnabled } from "./harness/sandbox.ts";
import { authority, fixtureConfig } from "./harness/scenario.ts";

const SERVER_PATH = "/opt/pi-sandbox-fixture/stdio-mcp.mjs";

const layerDockerfile = async () => {
  const source = await readFile(new URL("./fixtures/stdio-mcp-server.mjs", import.meta.url));

  return [
    `RUN mkdir -p /opt/pi-sandbox-fixture \\`,
    ` && echo ${source.toString("base64")} | base64 -d > ${SERVER_PATH} \\`,
    ` && chmod 0644 ${SERVER_PATH}`,
    "",
  ].join("\n");
};

describe.skipIf(!liveEnabled)("stdio MCP server from an image.dockerfile layer (live)", () => {
  const tool = `catalog_tool_${randomBytes(4).toString("hex")}`;
  const state: { sandbox?: LiveSandbox; catalog?: HttpsFixture } = {};

  beforeAll(async () => {
    const sandbox = await createLiveSandbox("stdio-mcp");

    state.sandbox = sandbox;

    state.catalog = await startHttpsFixture(sandbox.certificate, (_, response) => {
      sendJson(response, 200, { tool });
    });

    const dockerfile = await sandbox.writeFile("layer.Dockerfile", await layerDockerfile());

    await sandbox.writeAgentFile("mcp.json", {
      mcpServers: {
        catalog: {
          command: "node",
          args: [SERVER_PATH],
          env: { CATALOG_URL: state.catalog.url(FIXTURE_HOSTS.tools, "/catalog") },
        },
      },
    });

    await sandbox.writeUserConfig(
      fixtureConfig(sandbox, {
        allow: [authority(FIXTURE_HOSTS.tools, state.catalog.port)],
        extra: { image: { dockerfile } },
      }),
    );
  }, 120_000);

  afterAll(async () => {
    await state.catalog?.close();

    await state.sandbox?.cleanup();
  }, 120_000);

  it("lists the tool the server learned through the proxy", async () => {
    const sandbox = state.sandbox as LiveSandbox;
    const result = await sandbox.pi(["mcp", "list"]).done;

    expect(result.code).toBe(0);

    expect(result.stdout).toContain(tool);

    expect(state.catalog?.seen.map((request) => `${request.host}${request.path}`)).toContain(
      `${FIXTURE_HOSTS.tools}/catalog`,
    );

    const log = await sandbox.accessLog();

    expect(log).toContainEqual(expect.objectContaining({ host: FIXTURE_HOSTS.tools, decision: "allow" }));
  });
});
