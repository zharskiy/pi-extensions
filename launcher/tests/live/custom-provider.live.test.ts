import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type LlmFixture, startLlmFixture } from "./fixtures/llm-fixture.ts";
import { FIXTURE_HOSTS } from "./harness/names.ts";
import { createLiveSandbox, type LiveSandbox, liveEnabled } from "./harness/sandbox.ts";
import {
  fixtureConfig,
  MODEL_ARGS,
  providerModels,
  providerSettings,
  randomSecret,
} from "./harness/scenario.ts";

const REPLY = "custom provider reply from the fixture";

describe.skipIf(!liveEnabled)("custom baseUrl provider with an injected key (live)", () => {
  const apiKey = randomSecret("fixture-provider-key");
  const state: { sandbox?: LiveSandbox; llm?: LlmFixture } = {};

  beforeAll(async () => {
    const sandbox = await createLiveSandbox("custom-provider");

    state.sandbox = sandbox;

    state.llm = await startLlmFixture(sandbox.certificate, apiKey, () => ({ text: REPLY }));

    await sandbox.writeAgentFile("models.json", providerModels(state.llm.baseUrl(FIXTURE_HOSTS.llm), apiKey));

    await sandbox.writeAgentFile("settings.json", providerSettings());

    await sandbox.writeUserConfig(fixtureConfig(sandbox));
  }, 120_000);

  afterAll(async () => {
    await state.llm?.close();

    await state.sandbox?.cleanup();
  }, 120_000);

  it("answers through the fixture, which saw the real key while the container holds a placeholder", async () => {
    const sandbox = state.sandbox as LiveSandbox;
    const llm = state.llm as LlmFixture;
    const result = await sandbox.pi(["-p", "say hello", ...MODEL_ARGS]).done;

    expect(result.code).toBe(0);

    expect(result.stdout).toContain(REPLY);

    expect(llm.authorizations().length).toBeGreaterThan(0);

    expect(new Set(llm.authorizations())).toEqual(new Set([`Bearer ${apiKey}`]));

    const models = await sandbox.exec("cat ~/.pi/agent/models.json");

    expect(models.stdout).toContain(state.llm?.baseUrl(FIXTURE_HOSTS.llm));

    expect(models.stdout).not.toContain(apiKey);

    expect(models.stdout).toMatch(/pi-sandbox-[0-9a-f]{24}/);
  });
});
