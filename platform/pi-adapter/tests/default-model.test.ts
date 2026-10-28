import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxProvider } from "@earendil-works/pi-ai";
import * as pi from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTempDirs } from "../../../test/framework/index.ts";
import { createPiExtension } from "../index.ts";
import { childScope } from "../runtime/child-scope.ts";

const temp = useTempDirs();
const failures: string[] = [];

const saveEveryChoice = createPiExtension(
  (host) => {
    host.onModelSelect(async (ref) => {
      const failure = await host.saveDefaultModel(ref);

      if (failure) {
        failures.push(failure);
      }
    });
    host.onThinkingSelect(async (level) => {
      const failure = await host.saveDefaultThinkingLevel(level);

      if (failure) {
        failures.push(failure);
      }
    });
  },
  { root: "/ext", namespace: "test-model-default" },
);

const readSettings = (agentDir: string) => JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

const startSession = async (
  settings: object | string,
  options: { scoped?: string[]; child?: boolean } = {},
) => {
  const agentDir = temp.make("pi-default-model-agent-");
  const cwd = temp.make("pi-default-model-cwd-");

  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  writeFileSync(
    join(agentDir, "settings.json"),
    typeof settings === "string" ? settings : JSON.stringify(settings, null, 2),
  );

  const faux = fauxProvider({
    provider: "fake",
    models: [
      { id: "alpha", reasoning: true },
      { id: "beta", reasoning: true },
      { id: "gamma", reasoning: true },
    ],
  });
  const modelRuntime = await pi.ModelRuntime.create();
  const settingsManager = pi.SettingsManager.create(cwd, agentDir);
  const inScope = (scope: () => Promise<unknown>) =>
    options.child ? childScope.run({ agentId: "a1" }, scope) : scope();

  modelRuntime.registerNativeProvider(faux.provider);

  await modelRuntime.refresh({ allowNetwork: false });

  const loader = new pi.DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    extensionFactories: [{ name: "model-default", factory: saveEveryChoice }],
  });

  await inScope(() => loader.reload());

  const model = (id: string) => faux.getModel(id) as pi.ExtensionContext["model"] & object;

  const { session } = await pi.createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    model: model("alpha"),
    scopedModels: options.scoped?.map((id) => ({ model: model(id) })),
    resourceLoader: loader,
    settingsManager,
    sessionManager: pi.SessionManager.inMemory(cwd),
  });

  await session.bindExtensions({ mode: "print" });

  return { session, settingsManager, agentDir, model, inScope };
};

describe("saving the chosen model as pi's default", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    failures.length = 0;
  });

  it("writes the model picked with Enter into settings.json and keeps the other keys", async () => {
    const { session, agentDir, model } = await startSession({
      theme: "dark",
      defaultThinkingLevel: "high",
      defaultProvider: "fake",
      defaultModel: "alpha",
    });

    await session.setModel(model("beta"));

    expect(readSettings(agentDir)).toEqual({
      theme: "dark",
      defaultThinkingLevel: "high",
      defaultProvider: "fake",
      defaultModel: "beta",
    });

    session.dispose();
  });

  it("writes the model reached by cycling", async () => {
    const { session, agentDir } = await startSession({ defaultProvider: "fake", defaultModel: "alpha" });

    await session.cycleModel("forward");

    expect(readSettings(agentDir)).toMatchObject({ defaultProvider: "fake", defaultModel: "beta" });

    session.dispose();
  });

  it("adds the model to a model scope it is outside of, as Ctrl+S does", async () => {
    const { session, agentDir, model } = await startSession(
      { enabledModels: ["fake/alpha", "fake/beta"] },
      { scoped: ["alpha", "beta"] },
    );

    await session.setModel(model("gamma"));

    expect(readSettings(agentDir)).toMatchObject({
      defaultModel: "gamma",
      enabledModels: ["fake/alpha", "fake/beta", "fake/gamma"],
    });

    session.dispose();
  });

  it("leaves a scope that already holds the model alone", async () => {
    const { session, agentDir, model } = await startSession(
      { enabledModels: ["fake/alpha", "fake/beta"] },
      { scoped: ["alpha", "beta"] },
    );

    await session.setModel(model("beta"));

    expect(readSettings(agentDir)).toEqual({
      enabledModels: ["fake/alpha", "fake/beta"],
      defaultProvider: "fake",
      defaultModel: "beta",
    });

    session.dispose();
  });

  it("keeps the saved model when pi later saves another setting", async () => {
    const { session, settingsManager, agentDir, model } = await startSession({ theme: "dark" });

    await session.setModel(model("beta"));
    settingsManager.setTheme("light");
    await settingsManager.flush();

    expect(readSettings(agentDir)).toEqual({ theme: "light", defaultProvider: "fake", defaultModel: "beta" });

    session.dispose();
  });

  it("never changes the default from a subagent session", async () => {
    const settings = { defaultProvider: "fake", defaultModel: "alpha" };
    const { session, agentDir, model, inScope } = await startSession(settings, { child: true });

    await inScope(() => session.setModel(model("beta")));

    expect(readSettings(agentDir)).toEqual(settings);

    session.dispose();
  });

  it("reports a settings.json pi cannot read instead of overwriting it", async () => {
    const broken = '{ "defaultModel": ';
    const { session, agentDir, model } = await startSession(broken);

    await session.setModel(model("beta"));

    expect(readFileSync(join(agentDir, "settings.json"), "utf8")).toBe(broken);
    expect(failures).toHaveLength(1);

    session.dispose();
  });
});

describe("saving the chosen thinking level as pi's default", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    failures.length = 0;
  });

  it("saves nothing when a session starts", async () => {
    const settings = { theme: "dark", defaultProvider: "fake", defaultModel: "alpha" };
    const { session, agentDir } = await startSession(settings);

    await settle();

    expect(readSettings(agentDir)).toEqual(settings);

    session.dispose();
  });

  it("writes the level picked with Enter into settings.json and keeps the other keys", async () => {
    const { session, agentDir } = await startSession({
      theme: "dark",
      defaultThinkingLevel: "high",
      defaultProvider: "fake",
      defaultModel: "alpha",
    });

    session.setThinkingLevel("low");

    await vi.waitFor(() =>
      expect(readSettings(agentDir)).toEqual({
        theme: "dark",
        defaultThinkingLevel: "low",
        defaultProvider: "fake",
        defaultModel: "alpha",
      }),
    );
    expect(failures).toEqual([]);

    session.dispose();
  });

  it("writes the level reached by cycling", async () => {
    const { session, agentDir } = await startSession({ defaultThinkingLevel: "low" });

    const level = session.cycleThinkingLevel();

    expect(level).toBe("medium");

    await vi.waitFor(() => expect(readSettings(agentDir)).toEqual({ defaultThinkingLevel: "medium" }));

    session.dispose();
  });

  it("writes the level a model switch lands on", async () => {
    const { session, agentDir, model } = await startSession({ defaultThinkingLevel: "high" });

    session.setThinkingLevel("low");

    await vi.waitFor(() => expect(readSettings(agentDir)).toMatchObject({ defaultThinkingLevel: "low" }));

    await session.setModel(model("beta"));

    await vi.waitFor(() =>
      expect(readSettings(agentDir)).toEqual({
        defaultThinkingLevel: "high",
        defaultProvider: "fake",
        defaultModel: "beta",
      }),
    );

    session.dispose();
  });

  it("never changes the default from a subagent session", async () => {
    const settings = { defaultThinkingLevel: "high" };
    const { session, agentDir, inScope } = await startSession(settings, { child: true });

    await inScope(async () => {
      session.setThinkingLevel("low");
      session.cycleThinkingLevel();
    });
    await settle();

    expect(readSettings(agentDir)).toEqual(settings);

    session.dispose();
  });
});
