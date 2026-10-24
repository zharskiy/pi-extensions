import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AnyToolSpec } from "../../../../platform/pi-adapter/index.ts";
import { loadDefinitions } from "../../core/agent-definitions/loader.ts";
import { defaultSettings } from "../../core/model/settings.ts";
import {
  describeRunAgent,
  messageAgentTool,
  type RunAgentParams,
  runAgentTool,
} from "../../core/run-agent/tools.ts";
import { PACKAGE_ROOT } from "./subagents-harness.ts";

export type { RunAgentParams } from "../../core/run-agent/tools.ts";

export const mainSessionPrompt = () =>
  readFileSync(join(PACKAGE_ROOT, "prompts", "main-session.md"), "utf8").trim();

const roster = () => {
  const loaded = loadDefinitions([{ path: join(PACKAGE_ROOT, "agents"), source: "builtin" }]);

  return Array.from(loaded.definitions.values()).sort((left, right) => left.name.localeCompare(right.name));
};

const runAgentDescription = () => {
  const settings = defaultSettings();

  return describeRunAgent(roster(), {
    callerDepth: 1,
    maxDepth: settings.maxDepth,
    maxConcurrent: settings.maxConcurrent,
  });
};

const startedText = (params: RunAgentParams, batch: number) => {
  const list = params.agents
    .map((item, index) => `- a${batch}-${index + 1} (${item.agent}, model n/a)`)
    .join("\n");

  return `Started batch b${batch}:\n${list}\nYou will be woken once when all agents are done. End your turn now.`;
};

export const recordingTools = (calls: RunAgentParams[]): AnyToolSpec[] => {
  const runAgent = {
    ...runAgentTool({} as never, runAgentDescription()),
    execute: async (params: RunAgentParams) => {
      calls.push(params);

      return { text: startedText(params, calls.length) };
    },
  };

  const messageAgent = {
    ...messageAgentTool({} as never),
    execute: async () => ({ text: "Message delivered." }),
  };

  return [runAgent, messageAgent] as AnyToolSpec[];
};
