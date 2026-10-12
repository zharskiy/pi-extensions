import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentDir, ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe } from "vitest";
import type { AgentRuntime, UsageTotals } from "../../adapter/contract.ts";
import { createPiRuntime, type SkillFile } from "../../adapter/pi-child.ts";

const LIVE_PROVIDER = "openai";

const LIVE_MODEL_ID = "gpt-6-luna";

const LIVE_THINKING = "low";

const LIVE_MODEL = `${LIVE_PROVIDER}/${LIVE_MODEL_ID}`;

export const LIVE_AGENT_MODEL = `${LIVE_MODEL}:${LIVE_THINKING}`;

export const LIVE_TIMEOUT_MS = 180_000;

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

const COPIED_FILES = ["auth.json", "models.json"];

const CONTEXT_FILES = ["AGENTS.override.md", "AGENTS.md", "CLAUDE.md", "SYSTEM.md", "APPEND_SYSTEM.md"];

const realAgentDir = getAgentDir();

export const liveAgentDir = mkdtempSync(join(tmpdir(), "pi-live-agent-"));

COPIED_FILES.filter((name) => existsSync(join(realAgentDir, name))).forEach((name) => {
  copyFileSync(join(realAgentDir, name), join(liveAgentDir, name));
});

process.env[AGENT_DIR_ENV] = liveAgentDir;

export const removeLiveAgentDir = () => {
  rmSync(liveAgentDir, { recursive: true, force: true });
};

export const realContextMarkers = () =>
  CONTEXT_FILES.map((name) => join(realAgentDir, name))
    .filter((path) => existsSync(path))
    .flatMap((path) =>
      readFileSync(path, "utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .slice(0, 1),
    );

const registry = new ModelRegistry(await ModelRuntime.create());

const model = registry.find(LIVE_PROVIDER, LIVE_MODEL_ID);

const missingReason = () => {
  if (!model) {
    return `${LIVE_MODEL} is not in pi's model catalog`;
  }

  return registry.hasConfiguredAuth(model)
    ? undefined
    : `pi has no credentials for ${LIVE_MODEL} (log in with pi, or point PI_CODING_AGENT_DIR at an agent dir that has them)`;
};

const missing = missingReason();

if (missing) {
  removeLiveAgentDir();
}

export const describeLive = (name: string, body: () => void) =>
  describe.skipIf(missing)(missing ? `${name} (skipped: ${missing})` : name, body);

export type LiveParent = { trusted?: boolean; skillFiles?: SkillFile[] };

export const createLiveRuntime = (
  options: { namespace: string; exclude: string[] },
  parent: LiveParent = {},
): AgentRuntime => {
  const ctx = {
    model,
    modelRegistry: registry,
    isProjectTrusted: () => parent.trusted === true,
    ui: { theme: {} },
  };

  const skillFiles = parent.skillFiles;

  return createPiRuntime(
    {
      ctx: () => ctx as never,
      settings: () => ({ defaultProvider: LIVE_PROVIDER }) as never,
      thinking: () => LIVE_THINKING,
      ...(skillFiles ? { skillFiles: () => skillFiles } : {}),
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
