import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxProvider } from "@earendil-works/pi-ai";
import * as pi from "@earendil-works/pi-coding-agent";
import { vi } from "vitest";
import { childScope } from "../../../platform/pi-adapter/runtime/child-scope.ts";

type PiSessionOptions = {
  agentDir: string;
  cwd: string;
  factory: pi.ExtensionFactory;
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
  const inScope = <T>(scope: () => Promise<T>) =>
    options.child ? childScope.run({ agentId: "a1" }, scope) : scope();

  modelRuntime.registerNativeProvider(faux.provider);

  await modelRuntime.refresh({ allowNetwork: false });

  const loader = new pi.DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    extensionFactories: [{ name: "under-test", factory: options.factory }],
  });

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

  return { session, settingsManager, model, inScope };
};
