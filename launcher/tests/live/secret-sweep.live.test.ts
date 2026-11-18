import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type LlmFixture, startLlmFixture } from "./fixtures/llm-fixture.ts";
import { type McpFixture, startMcpFixture } from "./fixtures/mcp-fixture.ts";
import { FIXTURE_HOSTS } from "./harness/names.ts";
import { createLiveSandbox, type LiveSandbox, liveEnabled } from "./harness/sandbox.ts";
import {
  fixtureConfig,
  MODEL_ARGS,
  providerModels,
  providerSettings,
  randomSecret,
} from "./harness/scenario.ts";
import { type Secrets, sweepSandbox } from "./harness/sweep.ts";

const ENV_SECRET_NAME = "PI_SANDBOX_FIXTURE_ENV_SECRET";

describe.skipIf(!liveEnabled)(
  "secret sweep of the container filesystem, env and build context (live)",
  () => {
    const gitPassword = randomSecret("fixture-git-password");
    const secrets: Secrets = {
      providerKey: randomSecret("fixture-provider-key"),
      mcpToken: randomSecret("fixture-mcp-token"),
      gitPassword,
      gitBasic: Buffer.from(`deploy:${gitPassword}`).toString("base64"),
      envSecret: randomSecret("fixture-env-secret"),
    };
    const state: { sandbox?: LiveSandbox; llm?: LlmFixture; mcp?: McpFixture } = {};

    beforeAll(async () => {
      const sandbox = await createLiveSandbox("secret-sweep");

      state.sandbox = sandbox;

      state.llm = await startLlmFixture(sandbox.certificate, secrets.providerKey, () => ({ text: "swept" }));

      state.mcp = await startMcpFixture(sandbox.certificate, {
        tool: "sweep_tool",
        authorize: (seen) => seen === secrets.mcpToken,
      });

      const gitCredentials = await sandbox.writeFile(
        "git-credentials.json",
        JSON.stringify({ basic: secrets.gitBasic }),
      );

      await sandbox.writeAgentFile(
        "models.json",
        providerModels(state.llm.baseUrl(FIXTURE_HOSTS.llm), secrets.providerKey),
      );

      await sandbox.writeAgentFile("settings.json", providerSettings());

      await sandbox.writeAgentFile("mcp.json", {
        mcpServers: {
          fixture: {
            url: state.mcp.endpoint(FIXTURE_HOSTS.mcp),
            headers: { Authorization: `Bearer ${secrets.mcpToken}` },
          },
        },
      });

      await sandbox.writeUserConfig(
        fixtureConfig(sandbox, {
          extra: {
            credentials: {
              rules: [
                {
                  id: "fixture-git",
                  host: FIXTURE_HOSTS.git,
                  header: "authorization",
                  template: "Basic {secret}",
                  secret: { file: gitCredentials, pointer: "/basic" },
                },
                {
                  id: "fixture-env",
                  host: FIXTURE_HOSTS.page,
                  header: "x-fixture-token",
                  template: "{secret}",
                  secret: { env: ENV_SECRET_NAME },
                },
              ],
            },
          },
        }),
      );
    }, 120_000);

    afterAll(async () => {
      await state.llm?.close();

      await state.mcp?.close();

      await state.sandbox?.cleanup();
    }, 120_000);

    it("finds no fixture secret anywhere the container can read", async () => {
      const sandbox = state.sandbox as LiveSandbox;
      const env = { [ENV_SECRET_NAME]: secrets.envSecret };
      const prompt = await sandbox.pi(["-p", "say hello", ...MODEL_ARGS], { env }).done;
      const list = await sandbox.pi(["mcp", "list"], { env }).done;

      expect(prompt.code).toBe(0);

      expect(list.code).toBe(0);

      const { findings, scannedBytes } = await sweepSandbox(sandbox, secrets, env);

      expect(scannedBytes).toBeGreaterThan(10_000_000);

      expect(findings).toEqual([]);
    });
  },
);
