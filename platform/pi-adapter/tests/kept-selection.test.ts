import { fauxProvider } from "@earendil-works/pi-ai";
import * as pi from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTempDirs } from "../../../test/framework/index.ts";
import { createPiHost } from "../runtime/host.ts";
import type { ThinkingLevel } from "../types/model.ts";

const temp = useTempDirs();

const SEED = { customType: "handoff-seed", text: "carry on" };

const startHandoffRuntime = async () => {
  const dir = temp.make("pi-kept-selection-");

  vi.stubEnv("PI_CODING_AGENT_DIR", dir);

  const faux = fauxProvider({
    provider: "acme",
    models: [
      { id: "small", reasoning: true },
      { id: "large", reasoning: true },
    ],
  });
  const locked = fauxProvider({ provider: "vault", models: [{ id: "sealed", reasoning: true }] });
  const modelRuntime = await pi.ModelRuntime.create();

  modelRuntime.registerNativeProvider(faux.provider);
  modelRuntime.registerNativeProvider(locked.provider);

  const settingsManager = pi.SettingsManager.inMemory({
    defaultProvider: "acme",
    defaultModel: "small",
    defaultThinkingLevel: "low",
  });
  const warnings: string[] = [];

  const handoff: pi.ExtensionFactory = (api) => {
    const host = createPiHost(api, { tools: new Map() });

    host.registerCommand("handoff", {
      description: "hand off",
      run: async (args, control) => {
        await control.newSession({ keepSelection: args === "keep", seed: SEED });
      },
    });
  };

  const createRuntime: pi.CreateAgentSessionRuntimeFactory = async ({
    cwd,
    agentDir,
    sessionManager,
    sessionStartEvent,
  }) => {
    const services = await pi.createAgentSessionServices({
      cwd,
      agentDir,
      settingsManager,
      modelRuntime,
      resourceLoaderOptions: { extensionFactories: [{ name: "handoff", factory: handoff }] },
    });
    const created = await pi.createAgentSessionFromServices({ services, sessionManager, sessionStartEvent });

    return { ...created, services, diagnostics: services.diagnostics };
  };

  const runtime = await pi.createAgentSessionRuntime(createRuntime, {
    cwd: dir,
    agentDir: dir,
    sessionManager: pi.SessionManager.inMemory(dir),
  });

  const uiContext = {
    notify: (message: string, level: string) => {
      warnings.push(`${level}: ${message}`);
    },
  } as unknown as pi.ExtensionUIContext;

  const bind = async () => {
    await runtime.session.bindExtensions({
      mode: "print",
      uiContext,
      commandContextActions: {
        waitForIdle: () => runtime.session.waitForIdle(),
        newSession: (options) => runtime.newSession(options),
        fork: (entryId, options) => runtime.fork(entryId, options),
        navigateTree: async () => ({ cancelled: true }),
        switchSession: (sessionPath, options) => runtime.switchSession(sessionPath, options),
        reload: async () => {},
      },
    });
  };

  runtime.setRebindSession(bind);
  await bind();

  const select = async (model: pi.ExtensionContext["model"], thinking: ThinkingLevel) => {
    await runtime.session.setModel(model as never);
    runtime.session.setThinkingLevel(thinking);
  };

  const selection = () => ({
    model: `${runtime.session.model?.provider}/${runtime.session.model?.id}`,
    thinking: runtime.session.thinkingLevel,
  });

  const defaults = () => ({
    model: `${settingsManager.getDefaultProvider()}/${settingsManager.getDefaultModel()}`,
    thinking: settingsManager.getDefaultThinkingLevel(),
  });

  const seeded = () =>
    runtime.session.sessionManager
      .getEntries()
      .some((entry) => entry.type === "custom_message" && entry.customType === SEED.customType);

  return { runtime, faux, locked, modelRuntime, warnings, select, selection, defaults, seeded };
};

describe("keeping the model and thinking level across a handoff", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("starts the new session on the previous model and thinking level and leaves the defaults alone", async () => {
    const handoff = await startHandoffRuntime();

    await handoff.select(handoff.faux.getModel("large"), "high");
    await handoff.runtime.session.prompt("/handoff keep");

    expect(handoff.selection()).toEqual({ model: "acme/large", thinking: "high" });
    expect(handoff.defaults()).toEqual({ model: "acme/small", thinking: "low" });
    expect(handoff.seeded()).toBe(true);
    expect(handoff.warnings).toEqual([]);

    await handoff.runtime.dispose();
  });

  it("starts the new session on the defaults when not asked to keep the selection", async () => {
    const handoff = await startHandoffRuntime();

    await handoff.select(handoff.faux.getModel("large"), "high");
    await handoff.runtime.session.prompt("/handoff");

    expect(handoff.selection()).toEqual({ model: "acme/small", thinking: "low" });
    expect(handoff.seeded()).toBe(true);

    await handoff.runtime.dispose();
  });

  it("keeps the defaults and warns when the previous model has lost its credentials", async () => {
    const handoff = await startHandoffRuntime();

    await handoff.select(handoff.locked.getModel("sealed"), "high");
    handoff.modelRuntime.registerNativeProvider({ ...handoff.locked.provider, auth: {} });
    await handoff.runtime.session.prompt("/handoff keep");

    expect(handoff.selection()).toEqual({ model: "acme/small", thinking: "low" });
    expect(handoff.warnings).toEqual([
      "warning: Could not keep vault/sealed after the handoff; the new session uses acme/small.",
    ]);
    expect(handoff.seeded()).toBe(true);

    await handoff.runtime.dispose();
  });

  it("lowers the kept thinking level the way pi does when the kept model no longer reasons", async () => {
    const handoff = await startHandoffRuntime();
    const withoutReasoning = fauxProvider({
      provider: "acme",
      models: [
        { id: "small", reasoning: true },
        { id: "large", reasoning: false },
      ],
    });

    await handoff.select(handoff.faux.getModel("large"), "high");
    handoff.modelRuntime.registerNativeProvider(withoutReasoning.provider);
    await handoff.runtime.session.prompt("/handoff keep");

    expect(handoff.selection()).toEqual({ model: "acme/large", thinking: "off" });
    expect(handoff.warnings).toEqual([]);

    await handoff.runtime.dispose();
  });
});
