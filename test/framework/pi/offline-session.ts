import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type FauxProviderHandle, fauxProvider } from "@earendil-works/pi-ai";
import * as pi from "@earendil-works/pi-coding-agent";
import { vi } from "vitest";
import { childScope } from "../../../platform/pi-adapter/runtime/child-scope.ts";

type PiSessionOptions = {
  agentDir: string;
  cwd: string;
  factory: pi.ExtensionFactory;
  extraFactories?: pi.ExtensionFactory[];
  settings: object | string;
  models: { id: string; reasoning?: boolean }[];
  scoped?: string[];
  child?: boolean;
};

export const startPiSession = async (options: PiSessionOptions) => {
  const { agentDir, cwd, settings } = options;

  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  writeFileSync(
    join(agentDir, "settings.json"),
    typeof settings === "string" ? settings : JSON.stringify(settings, null, 2),
  );

  const faux = fauxProvider({ provider: "fake", models: options.models });
  const modelRuntime = await pi.ModelRuntime.create();
  const settingsManager = pi.SettingsManager.create(cwd, agentDir);

  modelRuntime.registerNativeProvider(faux.provider);

  await modelRuntime.refresh({ allowNetwork: false });

  const loader = new pi.DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    extensionFactories: [options.factory, ...(options.extraFactories ?? [])].map((factory, index) => ({
      name: index === 0 ? "under-test" : `under-test-${index}`,
      factory,
    })),
  });
  const inScope = <T>(scope: () => Promise<T>) =>
    options.child ? childScope.run({ agentId: "a1" }, scope) : scope();

  await inScope(() => loader.reload());

  const model = (id: string) => faux.getModel(id) as pi.ExtensionContext["model"] & object;
  const first = options.models[0]?.id ?? "";

  const { session } = await pi.createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    model: model(first),
    scopedModels: options.scoped?.map((id) => ({ model: model(id) })),
    resourceLoader: loader,
    settingsManager,
    sessionManager: pi.SessionManager.inMemory(cwd),
  });

  await session.bindExtensions({ mode: "print" });

  await vi.waitFor(() => {
    const listed = modelRuntime.getAvailableSnapshot().filter((model) => model.provider === "fake");

    if (listed.length < options.models.length) {
      throw new Error("faux models are not available yet");
    }
  });

  return { session, settingsManager, model, inScope };
};

type PiRuntimeOptions = {
  dir: string;
  providers: FauxProviderHandle[];
  settings: Parameters<typeof pi.SettingsManager.inMemory>[0];
  factories: Record<string, pi.ExtensionFactory>;
  ui?: Partial<pi.ExtensionUIContext>;
  model?: pi.ExtensionContext["model"];
  persisted?: boolean;
};

export const startPiRuntime = async (options: PiRuntimeOptions) => {
  const { dir } = options;

  vi.stubEnv("PI_CODING_AGENT_DIR", dir);

  const modelRuntime = await pi.ModelRuntime.create();

  options.providers.forEach((faux) => {
    modelRuntime.registerNativeProvider(faux.provider);
  });

  await modelRuntime.refresh({ allowNetwork: false });

  const settingsManager = pi.SettingsManager.inMemory(options.settings);
  const extensionFactories = Object.entries(options.factories).map(([name, factory]) => ({ name, factory }));

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
      resourceLoaderOptions: { extensionFactories },
    });
    const created = await pi.createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
      model: options.model as never,
    });

    return { ...created, services, diagnostics: services.diagnostics };
  };

  const runtime = await pi.createAgentSessionRuntime(createRuntime, {
    cwd: dir,
    agentDir: dir,
    sessionManager: options.persisted ? pi.SessionManager.create(dir, dir) : pi.SessionManager.inMemory(dir),
  });

  const uiContext = { notify: () => {}, ...options.ui } as pi.ExtensionUIContext;

  const bind = async () => {
    await runtime.session.bindExtensions({
      mode: "print",
      uiContext,
      commandContextActions: {
        waitForIdle: () => runtime.session.waitForIdle(),
        newSession: (newOptions) => runtime.newSession(newOptions),
        fork: (entryId, forkOptions) => runtime.fork(entryId, forkOptions),
        navigateTree: async () => ({ cancelled: true }),
        switchSession: (sessionPath, switchOptions) => runtime.switchSession(sessionPath, switchOptions),
        reload: async () => {},
      },
    });
  };

  runtime.setRebindSession(bind);

  await bind();

  return { runtime, settingsManager, modelRuntime };
};
