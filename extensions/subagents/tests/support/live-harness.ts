import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { expect } from "vitest";
import type { UsageTotals } from "../../../../pi-adapter/index.ts";
import {
  hiddenMessageTexts,
  reportCost,
  seedProjectFromCommit,
  totalCost,
  waitUntil,
} from "../../../../test-framework/index.ts";
import {
  LIVE_TIMEOUT_MS,
  liveAgentModel,
  liveChoreModel,
  startLiveExtension,
} from "../../../../test-framework/pi/live/index.ts";
import { NAMESPACE } from "../../core/model/paths.ts";
import type { Settings } from "../../core/model/settings.ts";
import type { RunAgentDetails, RunAgentParams } from "../../core/run-agent/tools.ts";
import extension from "../../src/index.ts";
import {
  type AgentGroup,
  type AgentPatch,
  modelForGroup,
  patchAgentFile,
  shippedGroup,
} from "./agent-patch.ts";
import { PACKAGE_ROOT, pluginSettings, tempDir } from "./subagents-harness.ts";

type LiveOptions = {
  agents: Record<string, AgentPatch>;
  settings?: Partial<Settings>;
  trusted?: boolean;
  skills?: Record<string, string>;
};

const shippedPath = (group: AgentGroup, from: string) => join(PACKAGE_ROOT, "agents", group, `${from}.md`);

const liveAgentFile = (name: string, patch: AgentPatch) => {
  const group = shippedGroup(patch.from, (candidate) => existsSync(shippedPath(candidate, patch.from)));
  const models = { lead: liveAgentModel(), chore: liveChoreModel() };
  const text = patchAgentFile(readFileSync(shippedPath(group, patch.from), "utf8"), {
    name,
    group,
    patch,
    models,
  });

  return { text, model: patch.fields?.model ?? modelForGroup(group, models) };
};

export const createLiveHarness = (label: string, options: LiveOptions) => {
  const root = tempDir("pi-subagents-live-");
  const project = join(root, "project");
  const agentDir = join(root, "agent");

  const skillFiles = Object.entries(options.skills ?? {}).map(([name, text]) => {
    const path = join(root, "skills", name, "SKILL.md");

    mkdirSync(join(root, "skills", name), { recursive: true });
    writeFileSync(path, text);

    return { name, description: "", path };
  });

  mkdirSync(project, { recursive: true });
  mkdirSync(join(agentDir, "agents"), { recursive: true });

  const expectedModels = new Map(
    Object.entries(options.agents).map(([name, patch]) => {
      const file = liveAgentFile(name, patch);

      writeFileSync(join(agentDir, "agents", `${name}.md`), file.text);

      return [name, file.model];
    }),
  );

  const {
    host,
    runtime,
    manager,
    errors,
    turn,
    close: shutdown,
  } = startLiveExtension({
    extension,
    settings: pluginSettings(options.settings),
    workDir: root,
    trusted: options.trusted,
    skillFiles: options.skills ? skillFiles : undefined,
  });
  const registry = manager.services.require("registry");
  const usage = new Map<string, UsageTotals>();

  manager.bus.on("agent:usage", (event) => {
    usage.set(event.id, event.usage);
  });

  const run = async (agent: string, task: string) => {
    const result = await turn(() =>
      host
        .tool<RunAgentParams, RunAgentDetails>("run_agent")
        .execute({ agents: [{ agent, task }] }, { update: () => {} }),
    );

    if (result.isError || !result.details) {
      throw new Error(result.text);
    }

    return result.details.ids[0];
  };

  const waitForWakes = (count: number, timeoutMs = LIVE_TIMEOUT_MS) =>
    waitUntil(
      () => hiddenMessageTexts(host).length >= count,
      timeoutMs,
      `${count} wake(s) of the main session`,
    );

  const seed = (sha: string) => {
    seedProjectFromCommit(project, sha);
  };

  const close = async () => {
    try {
      await shutdown();

      reportCost(label, totalCost(usage.values()));

      expect(errors).toEqual([]);

      const offModel = registry.list().filter((record) => record.model !== expectedModels.get(record.agent));

      expect(offModel).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(join(tmpdir(), NAMESPACE, basename(root)), { recursive: true, force: true });
    }
  };

  return { project, host, runtime, registry, usage, run, waitForWakes, seed, close };
};

export type LiveHarness = ReturnType<typeof createLiveHarness>;
