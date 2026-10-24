import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentDir, ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe } from "vitest";
import { isolateAgentDir, restoreAgentDir } from "./live-agent-dir.ts";

export const LIVE_TIMEOUT_MS = 180_000;

const MODEL_ENV = "PI_LIVE_MODEL";

const CHORE_MODEL_ENV = "PI_LIVE_CHORE_MODEL";

type ModelSpec = { provider: string; modelId: string; thinking: string | undefined };

type LiveState = {
  root: string;
  provider: string;
  modelId: string;
  thinking: string | undefined;
  registry: ModelRegistry;
  model: NonNullable<ReturnType<ModelRegistry["find"]>>;
  chore: ModelSpec | undefined;
};

let state: LiveState | undefined;

const parseModelSpec = (env: string): ModelSpec => {
  const spec = process.env[env];
  const match = spec?.match(/^([^/:\s]+)\/([^:\s]+)(?::(\w+))?$/);

  if (!match) {
    throw new Error(`Set ${env}=provider/id[:thinking] to run the live tests (got ${spec ?? "nothing"})`);
  }

  return { provider: match[1], modelId: match[2], thinking: match[3] };
};

const specText = ({ provider, modelId, thinking }: ModelSpec) =>
  `${provider}/${modelId}${thinking ? `:${thinking}` : ""}`;

const findUsable = (registry: ModelRegistry, { provider, modelId }: ModelSpec) => {
  const model = registry.find(provider, modelId);

  if (!model) {
    throw new Error(`${provider}/${modelId} is not in pi's model catalog`);
  }

  if (!registry.hasConfiguredAuth(model)) {
    throw new Error(`pi has no credentials for ${provider}/${modelId}; log in with pi first`);
  }

  return model;
};

const liveState = () => {
  if (!state) {
    throw new Error("setupLive() has not run");
  }

  return state;
};

const teardownLive = () => {
  restoreAgentDir();

  if (state) {
    rmSync(state.root, { recursive: true, force: true });
    state = undefined;
  }
};

const setupLive = async () => {
  if (state) {
    return;
  }

  const main = parseModelSpec(MODEL_ENV);
  const chore = process.env[CHORE_MODEL_ENV] ? parseModelSpec(CHORE_MODEL_ENV) : undefined;
  const realAgentDir = getAgentDir();
  const root = mkdtempSync(join(tmpdir(), "pi-live-agent-"));

  isolateAgentDir(realAgentDir, root);

  try {
    const registry = new ModelRegistry(await ModelRuntime.create());
    const model = findUsable(registry, main);

    if (chore) {
      findUsable(registry, chore);
    }

    state = { root, ...main, registry, model, chore };
  } catch (error) {
    restoreAgentDir();
    rmSync(root, { recursive: true, force: true });

    throw error;
  }
};

export const liveAgentModel = () => specText(liveState());

export const liveChoreModel = () => {
  const { chore } = liveState();

  return chore ? specText(chore) : liveAgentModel();
};

export const liveModel = () => {
  const { model, registry, provider, thinking } = liveState();

  return { model, registry, provider, thinking };
};

export const describeLive = (name: string, body: () => void) =>
  describe(name, () => {
    beforeAll(setupLive);
    afterAll(teardownLive);

    body();
  });
