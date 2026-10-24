import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionFactory,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { AnyToolSpec } from "../../../pi-adapter/index.ts";
import { replaceMainPrompt } from "../../../pi-adapter/prompt/main-prompt.ts";
import { toPiTool } from "../../../pi-adapter/tools/pi-tools.ts";
import { waitUntil } from "../../waiting.ts";
import { LIVE_TIMEOUT_MS, liveModel } from "./live-model.ts";

export type PiSessionOptions = {
  root: string;
  systemPrompt?: string;
  builtinTools?: string[];
  customTools?: AnyToolSpec[];
  skillPaths?: string[];
  extensions?: { name: string; factory: ExtensionFactory }[];
};

const promptOverride = (systemPrompt: string): { name: string; factory: ExtensionFactory } => ({
  name: "main-like-prompt",
  factory: (pi) => {
    pi.on("before_agent_start", (event) => {
      replaceMainPrompt(event.systemPromptOptions, systemPrompt);
    });
  },
});

const toolOptions = (options: PiSessionOptions) => {
  if (options.builtinTools === undefined && options.customTools === undefined) {
    return {};
  }

  const customTools = options.customTools ?? [];

  return {
    tools: [...(options.builtinTools ?? []), ...customTools.map((tool) => tool.name)],
    customTools: customTools.map((tool) => toPiTool(tool)),
  };
};

export const openPiSession = async (options: PiSessionOptions) => {
  const cwd = join(options.root, "project");
  const { model, thinking } = liveModel();
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.inMemory({}, { projectTrusted: false });

  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noSkills: true,
    additionalSkillPaths: options.skillPaths ?? [],
    extensionFactories: [
      ...(options.systemPrompt === undefined ? [] : [promptOverride(options.systemPrompt)]),
      ...(options.extensions ?? []),
    ],
  });

  mkdirSync(cwd, { recursive: true });
  await loader.reload();

  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime: await ModelRuntime.create(),
    model,
    thinkingLevel: (thinking ?? "off") as never,
    resourceLoader: loader,
    settingsManager,
    sessionManager: SessionManager.create(cwd, join(options.root, "sessions")),
    ...toolOptions(options),
  });
  const counter = { settled: 0 };

  session.subscribe((event) => {
    if (event.type === "agent_settled") {
      counter.settled += 1;
    }
  });

  await session.bindExtensions({ mode: "print" });

  const ask = async (text: string) => {
    const target = counter.settled + 1;

    await session.prompt(text, { expandPromptTemplates: false });
    await waitUntil(() => counter.settled >= target, LIVE_TIMEOUT_MS, "the main-like turn to settle");
  };

  return { cwd, session, ask, settledRuns: () => counter.settled, close: () => session.dispose() };
};
