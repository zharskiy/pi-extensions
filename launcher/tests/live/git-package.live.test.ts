import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extensionTool, type GitFixture, startGitFixture } from "./fixtures/git-https-fixture.ts";
import { type ChatRequest, type LlmFixture, startLlmFixture } from "./fixtures/llm-fixture.ts";
import { FIXTURE_HOSTS } from "./harness/names.ts";
import { createLiveSandbox, type LiveSandbox, liveEnabled } from "./harness/sandbox.ts";
import {
  authority,
  fixtureConfig,
  MODEL_ARGS,
  providerModels,
  providerSettings,
  randomSecret,
} from "./harness/scenario.ts";

const toolNames = (request: ChatRequest) => (request.tools ?? []).map((tool) => tool.function.name);

describe.skipIf(!liveEnabled)("pi install and pi update of a git-hosted extension package (live)", () => {
  const apiKey = randomSecret("fixture-provider-key");
  const credentials = { user: "deploy", password: randomSecret("fixture-git-password") };
  const offered: string[][] = [];
  const state: { sandbox?: LiveSandbox; llm?: LlmFixture; git?: GitFixture } = {};

  const source = () => state.git?.repoUrl(FIXTURE_HOSTS.git) ?? "";

  const packagesOf = async (sandbox: LiveSandbox) => {
    const settings = (await sandbox.readAgentFile("settings.json")) as { packages?: unknown[] };

    return JSON.stringify(settings.packages ?? []);
  };

  beforeAll(async () => {
    const sandbox = await createLiveSandbox("git-package");

    state.sandbox = sandbox;

    state.git = await startGitFixture(sandbox.certificate, sandbox.root, credentials);

    await state.git.publish(1);

    state.llm = await startLlmFixture(sandbox.certificate, apiKey, (request) => {
      offered.push(toolNames(request));

      return { text: "extension check" };
    });

    const credentialsFile = await sandbox.writeFile(
      "git-credentials.json",
      JSON.stringify({ basic: state.git.basic }),
    );

    await sandbox.writeAgentFile("models.json", providerModels(state.llm.baseUrl(FIXTURE_HOSTS.llm), apiKey));

    await sandbox.writeAgentFile("settings.json", providerSettings());

    await sandbox.writeUserConfig(
      fixtureConfig(sandbox, {
        allow: [authority(FIXTURE_HOSTS.git, state.git.port)],
        extra: {
          credentials: {
            rules: [
              {
                id: "fixture-git",
                host: FIXTURE_HOSTS.git,
                port: state.git.port,
                header: "authorization",
                template: "Basic {secret}",
                secret: { file: credentialsFile, pointer: "/basic" },
              },
            ],
          },
        },
      }),
    );
  }, 120_000);

  afterAll(async () => {
    await state.llm?.close();

    await state.git?.close();

    await state.sandbox?.cleanup();
  }, 120_000);

  it("installs the package inside and writes it back to the host settings.json", async () => {
    const sandbox = state.sandbox as LiveSandbox;
    const result = await sandbox.pi(["install", source()]).done;

    expect(result.code).toBe(0);

    expect(await packagesOf(sandbox)).toContain(source());

    expect(new Set(state.git?.authorizations())).toEqual(new Set([`Basic ${state.git?.basic}`]));
  });

  it("loads the installed extension", async () => {
    const sandbox = state.sandbox as LiveSandbox;
    const result = await sandbox.pi(["-p", "which tools do you have", ...MODEL_ARGS]).done;

    expect(result.code).toBe(0);

    expect(offered.at(-1)).toContain(extensionTool(1));
  });

  it("pulls a new commit with pi update --extensions", async () => {
    const sandbox = state.sandbox as LiveSandbox;

    await state.git?.publish(2);

    const update = await sandbox.pi(["update", "--extensions"]).done;

    expect(update.code).toBe(0);

    const result = await sandbox.pi(["-p", "which tools do you have now", ...MODEL_ARGS]).done;

    expect(result.code).toBe(0);

    expect(offered.at(-1)).toContain(extensionTool(2));

    expect(offered.at(-1)).not.toContain(extensionTool(1));
  });
});
