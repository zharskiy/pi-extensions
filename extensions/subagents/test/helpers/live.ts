import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { expect } from "vitest";
import type { UsageTotals } from "../../../../core/adapter/contract.ts";
import { errorText } from "../../../../core/manager/format.ts";
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
import {
  type AgentGroup,
  type AgentPatch,
  modelForGroup,
  patchAgentFile,
  shippedGroup,
} from "./agent-patch.ts";
import { PACKAGE_ROOT, startPlugins, tempDir, wakeTexts } from "./harness.ts";
import { createTurns } from "./turns.ts";

type LiveOptions = {
  agents: Record<string, AgentPatch>;
  settings?: Partial<Settings>;
  trusted?: boolean;
  skills?: Record<string, string>;
};

const REPO_ROOT = resolve(PACKAGE_ROOT, "..", "..");

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

const SEED_GIT = [
  "-c",
  "user.name=live",
  "-c",
  "user.email=live@example.invalid",
  "-c",
  "commit.gpgsign=false",
];

const seedStep = (command: string, args: string[], sha: string, cwd = REPO_ROOT) => {
  try {
    execFileSync(command, args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
  } catch (error) {
    throw new Error(`seeding the live project from ${sha} failed: ${errorText(error)}`);
  }
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

  const expectedModels = new Map(
    Object.entries(options.agents).map(([name, patch]) => {
      const file = liveAgentFile(name, patch);

      writeFileSync(join(agentDir, "agents", `${name}.md`), file.text);

      return [name, file.model];
    }),
  );

  const host = createFakeHost({
    id: basename(root),
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

  const turn = createTurns(host);

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
    waitUntil(() => wakeTexts(host).length >= count, timeoutMs, `${count} wake(s) of the main session`);

  const seed = (sha: string) => {
    const archive = join(root, "seed.tar");

    seedStep("/usr/bin/git", ["archive", "--format=tar", "--output", archive, sha], sha);
    seedStep("/usr/bin/tar", ["-xf", archive, "-C", project], sha);
    rmSync(archive);
    seedStep("/usr/bin/git", [...SEED_GIT, "init", "-q"], sha, project);
    seedStep("/usr/bin/git", [...SEED_GIT, "add", "-A"], sha, project);
    seedStep("/usr/bin/git", [...SEED_GIT, "commit", "-q", "--no-verify", "-m", "seed"], sha, project);

    if (existsSync(join(REPO_ROOT, "node_modules"))) {
      symlinkSync(join(REPO_ROOT, "node_modules"), join(project, "node_modules"));
      appendFileSync(join(project, ".git", "info", "exclude"), "node_modules\n");
    }
  };

  const close = async () => {
    try {
      await host.shutdown();

      reportCost(label, costOf(usage.values()));

      expect(errors).toEqual([]);

      const offModel = registry.list().filter((record) => record.model !== expectedModels.get(record.agent));

      expect(offModel).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
      // Handoff documents of this harness's session (handoffPathFor).
      rmSync(join(tmpdir(), NAMESPACE, basename(root)), { recursive: true, force: true });
    }
  };

  return { project, host, runtime, registry, usage, run, waitForWakes, seed, close };
};

export type LiveHarness = ReturnType<typeof createLiveHarness>;
