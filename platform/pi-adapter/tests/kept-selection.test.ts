import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import * as pi from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTempDirs } from "../../../test/framework/index.ts";
import { createPiHost } from "../runtime/host.ts";
import type { ThinkingLevel } from "../types/model.ts";

const temp = useTempDirs();

const SEED = { customType: "handoff-seed", text: "carry on" };

const flush = () => new Promise((resolve) => setImmediate(resolve));

const startHandoffRuntime = async (settings: object = {}) => {
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
    ...settings,
  });
  const warnings: string[] = [];
  const reported: string[] = [];
  const pending: Promise<unknown>[] = [];

  const handoff: pi.ExtensionFactory = (api) => {
    const host = createPiHost(api, { tools: new Map() });

    host.registerCommand("handoff", {
      description: "hand off",
      run: async (args, control) => {
        const words = args.split(" ");

        await control.newSession({
          keepSelection: words.includes("keep"),
          continueWithSeed: words.includes("continue"),
          seed: SEED,
        });
      },
    });
  };

  const bystander: pi.ExtensionFactory = (api) => {
    createPiHost(api, { tools: new Map() });
  };

  const chooser: pi.ExtensionFactory = (api) => {
    const host = createPiHost(api, { tools: new Map() });

    host.onModelSelect(async (ref) => {
      const save = host.saveDefaultModel(ref);

      reported.push(`model ${ref}`);
      pending.push(save);
      await save;
    });
    host.onThinkingSelect(async (level) => {
      const save = host.saveDefaultThinkingLevel(level);

      reported.push(`thinking ${level}`);
      pending.push(save);
      await save;
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
      resourceLoaderOptions: {
        extensionFactories: [
          { name: "handoff", factory: handoff },
          { name: "bystander", factory: bystander },
          { name: "chooser", factory: chooser },
        ],
      },
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

  const saved = () => {
    const file = join(dir, "settings.json");

    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  };

  const drain = async () => {
    await flush();
    await Promise.all(pending.splice(0));
  };

  const handOffFromSaved = async (
    start: () => Promise<unknown> = () => runtime.session.prompt("/handoff keep"),
  ) => {
    await drain();

    const before = saved();

    reported.length = 0;
    await start();
    await drain();

    return before;
  };

  const seeded = () =>
    runtime.session.sessionManager
      .getEntries()
      .some((entry) => entry.type === "custom_message" && entry.customType === SEED.customType);

  const modelAtSeed = () => {
    const entries = runtime.session.sessionManager.getEntries();
    const seedAt = entries.findIndex(
      (entry) => entry.type === "custom_message" && entry.customType === SEED.customType,
    );
    const change = entries.slice(0, seedAt).findLast((entry) => entry.type === "model_change");

    return change?.type === "model_change" ? `${change.provider}/${change.modelId}` : undefined;
  };

  const roles = () =>
    runtime.session.sessionManager.getEntries().flatMap((entry) => {
      if (entry.type === "message") {
        return [entry.message.role];
      }

      return entry.type === "custom_message" ? [entry.customType] : [];
    });

  return {
    runtime,
    faux,
    locked,
    modelRuntime,
    warnings,
    reported,
    select,
    selection,
    defaults,
    saved,
    drain,
    handOffFromSaved,
    seeded,
    modelAtSeed,
    roles,
  };
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
    expect(handoff.modelAtSeed()).toBe("acme/large");
    expect(handoff.warnings).toEqual([]);

    await handoff.runtime.dispose();
  });

  it("runs the seed as a turn on the kept model when asked to continue", async () => {
    const handoff = await startHandoffRuntime();
    const requested: string[] = [];

    handoff.faux.setResponses([
      (_context, _options, _state, model) => {
        requested.push(`${model.provider}/${model.id}`);

        return fauxAssistantMessage(fauxText("continuing"));
      },
    ]);

    await handoff.select(handoff.faux.getModel("large"), "high");
    await handoff.runtime.session.prompt("/handoff keep continue");
    await handoff.runtime.session.waitForIdle();

    expect(requested).toEqual(["acme/large"]);
    expect(handoff.roles().slice(-2)).toEqual([SEED.customType, "assistant"]);
    expect(handoff.warnings).toEqual([]);

    await handoff.runtime.dispose();
  });

  it("reports and saves nothing while the handoff restores a thinking level that differs from the reset one", async () => {
    const handoff = await startHandoffRuntime({ modelThinkingLevels: { "acme/large": "medium" } });

    await handoff.select(handoff.faux.getModel("large"), "high");

    const before = await handoff.handOffFromSaved();

    expect(handoff.selection()).toEqual({ model: "acme/large", thinking: "high" });
    expect(handoff.reported).toEqual([]);
    expect(handoff.saved()).toEqual(before);

    handoff.runtime.session.setThinkingLevel("minimal");
    await handoff.drain();

    expect(handoff.reported).toEqual(["thinking minimal"]);
    expect(handoff.saved()).toMatchObject({ defaultThinkingLevel: "minimal" });

    await handoff.select(handoff.faux.getModel("small"), "medium");
    await handoff.drain();

    expect(handoff.reported).toEqual(["thinking minimal", "model acme/small", "thinking medium"]);
    expect(handoff.saved()).toMatchObject({
      defaultProvider: "acme",
      defaultModel: "small",
      defaultThinkingLevel: "medium",
    });

    await handoff.runtime.dispose();
  });

  it("appends the seed without a turn when not asked to continue", async () => {
    const handoff = await startHandoffRuntime();

    await handoff.runtime.session.prompt("/handoff keep");
    await handoff.runtime.session.waitForIdle();

    expect(handoff.roles()).toEqual([SEED.customType]);
    expect(handoff.faux.state.callCount).toBe(0);

    await handoff.runtime.dispose();
  });

  it("reports and saves nothing while the handoff restores a thinking level equal to the reset one", async () => {
    const handoff = await startHandoffRuntime({ modelThinkingLevels: { "acme/large": "medium" } });

    await handoff.select(handoff.faux.getModel("large"), "medium");

    const before = await handoff.handOffFromSaved();

    expect(handoff.selection()).toEqual({ model: "acme/large", thinking: "medium" });
    expect(handoff.reported).toEqual([]);
    expect(handoff.saved()).toEqual(before);

    await handoff.runtime.session.setModel(handoff.faux.getModel("small") as never);
    await handoff.drain();

    expect(handoff.reported).toEqual(["model acme/small"]);
    expect(handoff.saved()).toMatchObject({ defaultProvider: "acme", defaultModel: "small" });

    await handoff.runtime.dispose();
  });

  it("reports and saves nothing while the handoff clamps the kept level of a model that no longer reasons", async () => {
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

    const before = await handoff.handOffFromSaved();

    expect(handoff.selection()).toEqual({ model: "acme/large", thinking: "off" });
    expect(handoff.reported).toEqual([]);
    expect(handoff.saved()).toEqual(before);

    await handoff.select(withoutReasoning.getModel("small"), "high");
    await handoff.drain();

    expect(handoff.reported).toEqual(["model acme/small", "thinking high"]);
    expect(handoff.saved()).toMatchObject({
      defaultProvider: "acme",
      defaultModel: "small",
      defaultThinkingLevel: "high",
    });

    await handoff.runtime.dispose();
  });

  it("passes a switch back to the restored model once the user has moved away from it", async () => {
    const handoff = await startHandoffRuntime();

    await handoff.select(handoff.faux.getModel("large"), "high");
    await handoff.handOffFromSaved();
    await handoff.runtime.session.setModel(handoff.faux.getModel("small") as never);
    await handoff.runtime.session.setModel(handoff.faux.getModel("large") as never);
    await handoff.drain();

    expect(handoff.reported).toEqual(["model acme/small", "model acme/large"]);
    expect(handoff.saved()).toMatchObject({ defaultProvider: "acme", defaultModel: "large" });

    await handoff.runtime.dispose();
  });

  it("passes a return to the restored level once the user has picked another", async () => {
    const handoff = await startHandoffRuntime();

    await handoff.select(handoff.faux.getModel("large"), "high");
    await handoff.handOffFromSaved();
    handoff.runtime.session.setThinkingLevel("minimal");
    await handoff.drain();
    handoff.runtime.session.setThinkingLevel("high");
    await handoff.drain();

    expect(handoff.reported).toEqual(["thinking minimal", "thinking high"]);
    expect(handoff.saved()).toMatchObject({ defaultThinkingLevel: "high" });

    await handoff.runtime.dispose();
  });

  it("passes the user's pick of a model the handoff failed to restore", async () => {
    const handoff = await startHandoffRuntime();

    await handoff.select(handoff.locked.getModel("sealed"), "high");
    handoff.modelRuntime.registerNativeProvider({ ...handoff.locked.provider, auth: {} });
    await handoff.handOffFromSaved();
    handoff.modelRuntime.registerNativeProvider(handoff.locked.provider);
    await handoff.runtime.session.setModel(handoff.locked.getModel("sealed") as never);
    await handoff.drain();

    expect(handoff.warnings).toHaveLength(1);
    expect(handoff.reported).toEqual(["model vault/sealed"]);
    expect(handoff.saved()).toMatchObject({ defaultProvider: "vault", defaultModel: "sealed" });

    await handoff.runtime.dispose();
  });

  it("reports and saves nothing for a kept thinking value that is not a level and passes a later pick", async () => {
    const handoff = await startHandoffRuntime({ modelThinkingLevels: { "acme/large": "medium" } });
    const keepBogus = async (sessionManager: pi.SessionManager) => {
      sessionManager.appendCustomEntry("pi-adapter:kept-selection", {
        provider: "acme",
        id: "large",
        thinking: "bogus",
      });
    };

    const before = await handoff.handOffFromSaved(() => handoff.runtime.newSession({ setup: keepBogus }));

    expect(handoff.selection()).toEqual({ model: "acme/large", thinking: "medium" });
    expect(handoff.reported).toEqual([]);
    expect(handoff.saved()).toEqual(before);

    handoff.runtime.session.setThinkingLevel("high");
    await handoff.drain();

    expect(handoff.reported).toEqual(["thinking high"]);
    expect(handoff.saved()).toMatchObject({ defaultThinkingLevel: "high" });

    await handoff.runtime.dispose();
  });

  it("reports and saves nothing when the kept model is the one the new session starts on", async () => {
    const handoff = await startHandoffRuntime();

    await handoff.select(handoff.faux.getModel("small"), "high");

    const before = await handoff.handOffFromSaved();

    expect(handoff.selection()).toEqual({ model: "acme/small", thinking: "high" });
    expect(handoff.reported).toEqual([]);
    expect(handoff.saved()).toEqual(before);

    await handoff.runtime.session.setModel(handoff.faux.getModel("large") as never);
    await handoff.drain();

    expect(handoff.reported).toEqual(["model acme/large"]);
    expect(handoff.saved()).toMatchObject({ defaultProvider: "acme", defaultModel: "large" });

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
