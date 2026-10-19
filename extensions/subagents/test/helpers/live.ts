import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect } from "vitest";
import type { UsageTotals } from "../../../../core/adapter/contract.ts";
import {
  costOf,
  createLiveRuntime,
  LIVE_TIMEOUT_MS,
  liveAgentModel,
  liveChoreModel,
  reportCost,
  waitUntil,
} from "../../../../core/test/adapter/live.ts";
import { createFakeHost } from "../../../../core/test/helpers/fakes.ts";
import { NAMESPACE } from "../../src/model/paths.ts";
import type { Settings } from "../../src/model/settings.ts";
import type { RunAgentDetails, RunAgentParams } from "../../src/plugins/run-agent/render.ts";
import { plugins } from "../../src/plugins.ts";
import { type AgentGroup, type AgentPatch, patchAgentFile } from "./agent-patch.ts";
import { PACKAGE_ROOT, startPlugins, tempDir, wakeTexts } from "./harness.ts";

type LiveOptions = {
  agents: Record<string, AgentPatch>;
  settings?: Partial<Settings>;
  trusted?: boolean;
  skills?: Record<string, string>;
};

const REPO_ROOT = resolve(PACKAGE_ROOT, "..", "..");

const GROUPS: AgentGroup[] = ["leads", "chores"];

const liveAgentFile = (name: string, patch: AgentPatch) => {
  const group = GROUPS.find((candidate) =>
    existsSync(join(PACKAGE_ROOT, "agents", candidate, `${patch.from}.md`)),
  );

  if (!group) {
    throw new Error(`no shipped agent named ${patch.from}`);
  }

  const source = readFileSync(join(PACKAGE_ROOT, "agents", group, `${patch.from}.md`), "utf8");

  return patchAgentFile(source, {
    name,
    group,
    patch,
    models: { lead: liveAgentModel(), chore: liveChoreModel() },
  });
};

export const createLiveHarness = (label: string, options: LiveOptions) => {
  const root = tempDir("pi-subagents-live-");
  const project = join(root, "project");
  const agentDir = join(root, "agent");

  const skillFiles = Object.entries(options.skills ?? {}).map(([name, text]) => {
    const path = join(root, "skills", name, "SKILL.md");

    mkdirSync(join(root, "skills", name), { recursive: true });
    writeFileSync(path, text);

    return { name, path };
  });

  const runtime = createLiveRuntime(
    { namespace: NAMESPACE, exclude: [join(PACKAGE_ROOT, "src")] },
    { trusted: options.trusted, skillFiles: options.skills ? skillFiles : undefined },
  );

  mkdirSync(project, { recursive: true });
  mkdirSync(join(agentDir, "agents"), { recursive: true });

  Object.entries(options.agents).forEach(([name, patch]) => {
    writeFileSync(join(agentDir, "agents", `${name}.md`), liveAgentFile(name, patch));
  });

  const host = createFakeHost({
    id: "live-main",
    file: join(root, "sessions", "main.jsonl"),
    cwd: project,
    agentDir,
    mode: "print",
  });

  const { manager, errors } = startPlugins(host, runtime, plugins, options.settings);
  const registry = manager.services.require("registry");
  const usage = new Map<string, UsageTotals>();

  manager.bus.on("agent:usage", (event) => {
    usage.set(event.id, event.usage);
  });

  const run = async (agent: string, task: string) => {
    host.idle = false;

    const result = await host
      .tool<RunAgentParams, RunAgentDetails>("run_agent")
      .execute({ agents: [{ agent, task }] }, { update: () => {} });

    if (result.isError || !result.details) {
      throw new Error(result.text);
    }

    host.settle();

    return result.details.ids[0];
  };

  const waitForWakes = (count: number, timeoutMs = LIVE_TIMEOUT_MS) =>
    waitUntil(() => wakeTexts(host).length >= count, timeoutMs, `${count} wake(s) of the main session`);

  const seed = (sha: string) => {
    const archive = join(root, "seed.tar");

    execFileSync("/usr/bin/git", ["archive", "--format=tar", "--output", archive, sha], { cwd: REPO_ROOT });
    execFileSync("tar", ["-xf", archive, "-C", project]);
    rmSync(archive);
  };

  const close = async () => {
    try {
      await host.shutdown();

      reportCost(label, costOf(usage.values()));

      expect(errors).toEqual([]);
      const models = [liveAgentModel(), liveChoreModel()];

      expect(registry.list().filter((record) => !models.includes(record.model ?? ""))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  return { project, host, runtime, registry, usage, run, waitForWakes, seed, close };
};

export type LiveHarness = ReturnType<typeof createLiveHarness>;
