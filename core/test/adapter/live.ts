import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionFactory,
  getAgentDir,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe } from "vitest";
import type { AgentRuntime, AnyToolSpec, UsageTotals } from "../../adapter/contract.ts";
import { replaceMainPrompt } from "../../adapter/main-prompt.ts";
import { createPiRuntime, type SkillFile } from "../../adapter/pi-child.ts";
import { toPiTool } from "../../adapter/pi-tools.ts";

export const LIVE_TIMEOUT_MS = 180_000;

const MODEL_ENV = "PI_LIVE_MODEL";

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

const COPIED_FILES = ["auth.json", "models.json"];

const CONTEXT_FILES = ["AGENTS.override.md", "AGENTS.md", "CLAUDE.md", "SYSTEM.md", "APPEND_SYSTEM.md"];

type LiveState = {
  realAgentDir: string;
  agentDir: string;
  provider: string;
  modelId: string;
  thinking: string | undefined;
  registry: ModelRegistry;
  model: NonNullable<ReturnType<ModelRegistry["find"]>>;
};

let state: LiveState | undefined;

const parseModelSpec = (spec: string | undefined) => {
  const match = spec?.match(/^([^/:\s]+)\/([^:\s]+)(?::(\w+))?$/);

  if (!match) {
    throw new Error(
      `Set ${MODEL_ENV}=provider/id[:thinking] to run the live tests (got ${spec ?? "nothing"})`,
    );
  }

  return { provider: match[1], modelId: match[2], thinking: match[3] };
};

const liveState = () => {
  if (!state) {
    throw new Error("setupLive() has not run");
  }

  return state;
};

export const setupLive = async () => {
  if (state) {
    return;
  }

  const { provider, modelId, thinking } = parseModelSpec(process.env[MODEL_ENV]);
  const realAgentDir = getAgentDir();
  const agentDir = mkdtempSync(join(tmpdir(), "pi-live-agent-"));

  COPIED_FILES.filter((name) => existsSync(join(realAgentDir, name))).forEach((name) => {
    copyFileSync(join(realAgentDir, name), join(agentDir, name));
  });

  process.env[AGENT_DIR_ENV] = agentDir;

  try {
    const registry = new ModelRegistry(await ModelRuntime.create());
    const model = registry.find(provider, modelId);

    if (!model) {
      throw new Error(`${provider}/${modelId} is not in pi's model catalog`);
    }

    if (!registry.hasConfiguredAuth(model)) {
      throw new Error(`pi has no credentials for ${provider}/${modelId}; log in with pi first`);
    }

    state = { realAgentDir, agentDir, provider, modelId, thinking, registry, model };
  } catch (error) {
    rmSync(agentDir, { recursive: true, force: true });

    throw error;
  }
};

export const teardownLive = () => {
  if (state) {
    rmSync(state.agentDir, { recursive: true, force: true });
    state = undefined;
  }
};

export const liveAgentModel = () => {
  const { provider, modelId, thinking } = liveState();

  return `${provider}/${modelId}${thinking ? `:${thinking}` : ""}`;
};

export const liveModel = () => {
  const { model, thinking } = liveState();

  return { model, thinking };
};

export const realContextMarkers = () =>
  CONTEXT_FILES.map((name) => join(liveState().realAgentDir, name))
    .filter((path) => existsSync(path))
    .flatMap((path) =>
      readFileSync(path, "utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .slice(0, 1),
    );

export const describeLive = (name: string, body: () => void) =>
  describe(name, () => {
    beforeAll(setupLive);
    afterAll(teardownLive);

    body();
  });

const PI_DEFAULT_TOOLS = ["read", "bash", "edit", "write"];

export type LiveParent = { trusted?: boolean; skillFiles?: SkillFile[] };

export const createLiveRuntime = (
  options: { namespace: string; exclude: string[] },
  parent: LiveParent = {},
): AgentRuntime => {
  const { model, registry, provider, thinking } = liveState();

  const ctx = {
    model,
    modelRegistry: registry,
    isProjectTrusted: () => parent.trusted === true,
    ui: { theme: {} },
  };

  return createPiRuntime(
    {
      ctx: () => ctx as never,
      settings: () => ({ defaultProvider: provider }) as never,
      thinking: () => thinking ?? "off",
      skillFiles: () => parent.skillFiles ?? [],
      activeTools: () => PI_DEFAULT_TOOLS.map((name) => ({ name, path: `builtin:${name}` })),
      mcpDisabled: () => false,
    },
    options,
  );
};

type SessionLine = { type?: string; parentSession?: string; message?: { role?: string; content?: unknown } };

export const sessionLines = (file: string) =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as SessionLine);

export const sessionHeader = (file: string) => sessionLines(file).find((line) => line.type === "session");

export const quiet = (ms: number) => new Promise((done) => setTimeout(done, ms));

export const waitUntil = async (check: () => boolean, timeoutMs: number, label: string): Promise<void> => {
  const deadline = Date.now() + timeoutMs;

  const poll = async (): Promise<void> => {
    if (check()) {
      return;
    }

    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${label}`);
    }

    await quiet(250);

    return poll();
  };

  return poll();
};

export const costOf = (usages: Iterable<UsageTotals>) =>
  Array.from(usages).reduce((sum, usage) => sum + usage.cost.total, 0);

export const reportCost = (label: string, cost: number) => {
  console.log(`[live cost] ${label}: $${cost.toFixed(6)}`);
};

export type MainLikeOptions = {
  root: string;
  systemPrompt: string;
  builtinTools: string[];
  customTools: AnyToolSpec[];
  skillPaths?: string[];
};

export const openMainLikeSession = async (options: MainLikeOptions) => {
  const cwd = join(options.root, "project");
  const { model, thinking } = liveModel();
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.inMemory({}, { projectTrusted: false });

  const override: ExtensionFactory = (pi) => {
    pi.on("before_agent_start", (event) => {
      replaceMainPrompt(event.systemPromptOptions, options.systemPrompt);
    });
  };

  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noSkills: true,
    additionalSkillPaths: options.skillPaths ?? [],
    extensionFactories: [{ name: "main-like-prompt", factory: override }],
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
    tools: [...options.builtinTools, ...options.customTools.map((tool) => tool.name)],
    customTools: options.customTools.map((tool) => toPiTool(tool)),
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

  return { cwd, ask, close: () => session.dispose() };
};
