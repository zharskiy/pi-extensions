import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { flushMicrotasks } from "../../../../../test-framework/index.ts";
import { agentDefinitionsPlugin } from "../../../api/plugins/agent-definitions.ts";
import { agentRegistryPlugin } from "../../../api/plugins/agent-registry.ts";
import { limitsPlugin } from "../../../api/plugins/limits.ts";
import { runAgentPlugin } from "../../../api/plugins/run-agent.ts";
import type { AgentRecord } from "../../../core/model/types.ts";
import type { Runner } from "../../../core/run-agent/runner.ts";
import type { RunAgentDetails, RunAgentParams } from "../../../core/run-agent/tools.ts";
import { createHarness } from "../../support/subagents-harness.ts";

const HEADER = "description: d\nlimit: 50000\nsubagents: []\n";

const setup = (definitions: Record<string, string> = {}, overrides = {}) => {
  const harness = createHarness([agentRegistryPlugin, agentDefinitionsPlugin, runAgentPlugin, limitsPlugin], {
    overrides,
  });
  const dir = join(harness.host.info.agentDir, "agents");

  mkdirSync(dir, { recursive: true });

  Object.entries(definitions).forEach(([name, grants]) => {
    writeFileSync(join(dir, `${name}.md`), `---\nname: ${name}\n${HEADER}${grants}\n---\n`);
  });

  harness.host.start();
  harness.runtime.skills = ["docs", "git", "tdd"];

  const registry = harness.services.require("registry");
  const runner = harness.services.require("runner") as Runner;

  const run = async (agents: RunAgentParams["agents"]) => {
    harness.host.idle = false;

    const result = await harness.host
      .tool<RunAgentParams, RunAgentDetails>("run_agent")
      .execute({ agents }, { update: () => {} });

    await flushMicrotasks();

    return result;
  };

  return { ...harness, registry, runner, run };
};

describe("run_agent skills", () => {
  it("adds the item's skills to the definition's list, without duplicates", async () => {
    const { run, runtime } = setup({ named: "tools: all\nskills: [docs]" });

    await run([{ agent: "named", task: "a", skills: ["tdd", "docs", "tdd"] }]);

    expect(runtime.children[0].spec.skills).toEqual(["docs", "tdd"]);
  });

  it("resolves all to the main session's skills plus the item's, and [] to none", async () => {
    const { run, runtime } = setup({ every: "tools: all\nskills: all", none: "tools: all\nskills: []" });

    await run([
      { agent: "every", task: "a", skills: ["tdd"] },
      { agent: "none", task: "b" },
    ]);

    expect(runtime.children.map((child) => child.spec.skills)).toEqual([["docs", "git", "tdd"], []]);
  });

  it("fails the whole batch on a skill the caller lacks, lists its skills, starts nothing", async () => {
    const { run, registry, runtime } = setup();

    await expect(
      run([
        { agent: "scout", task: "a", skills: ["tdd"] },
        { agent: "reviewer", task: "b", skills: ["tdd", "lint", "fmt"] },
      ]),
    ).rejects.toThrow(
      'reviewer: skill(s) "lint", "fmt" not in this caller\'s skills. This caller\'s skills: docs, git, tdd. Nothing was started.',
    );
    expect(registry.list()).toEqual([]);
    expect(runtime.children).toEqual([]);
  });

  it("says the caller has no skills when the main session has none", async () => {
    const { run, registry, runtime } = setup();

    runtime.skills = [];

    await expect(run([{ agent: "scout", task: "a", skills: ["tdd"] }])).rejects.toThrow(
      'scout: skill(s) "tdd" not in this caller\'s skills. This caller has no skills. Nothing was started.',
    );
    expect(registry.list()).toEqual([]);
  });

  it("refuses skills for an agent whose tools do not include read", async () => {
    const { run, registry } = setup({ blind: "tools: [bash]\nskills: []" });

    await expect(run([{ agent: "blind", task: "a", skills: ["tdd"] }])).rejects.toThrow(
      "blind: cannot use skills, its tools do not include read. Nothing was started.",
    );
    expect(registry.list()).toEqual([]);

    await run([{ agent: "blind", task: "a" }]);

    expect(registry.list()).toHaveLength(1);
  });

  it("validates a skills: all caller's items against the skills it resolved from its caller", async () => {
    const { run, registry, runner, runtime } = setup();

    await run([{ agent: "general", task: "lead" }]);

    const lead = registry.list()[0];

    expect(() =>
      runner.startBatch([{ agent: "scout", task: "a", skills: ["lint"] }], {
        callerId: lead.id,
        wait: false,
      }),
    ).toThrow(
      "scout: skill(s) \"lint\" not in this caller's skills. This caller's skills: docs, git, tdd. Nothing was started.",
    );

    runner.startBatch([{ agent: "scout", task: "a", skills: ["git"] }], { callerId: lead.id, wait: false });
    await flushMicrotasks();

    expect(runtime.children[1].spec.skills).toEqual(["git"]);
  });

  it("bounds the main session by its loaded skills, while the inventory names definition skills", async () => {
    const { run, registry, runtime } = setup({ named: "tools: all\nskills: [lint]" });

    runtime.skills = ["docs", "git", "lint"];
    runtime.sessionSkills = ["docs", "git"];

    await expect(run([{ agent: "scout", task: "a", skills: ["lint"] }])).rejects.toThrow(
      "scout: skill(s) \"lint\" not in this caller's skills. This caller's skills: docs, git. Nothing was started.",
    );
    expect(registry.list()).toEqual([]);

    await run([
      { agent: "named", task: "a" },
      { agent: "general", task: "b" },
    ]);

    expect(runtime.children.map((child) => child.spec.skills)).toEqual([["lint"], ["docs", "git"]]);
  });

  it("resolves all to the calling agent's skills when an agent starts the agent", async () => {
    const { run, registry, runner, runtime } = setup({
      lead: "tools: all\nskills: [docs]\nsubagents: [every]",
      every: "tools: all\nskills: all",
    });

    await run([{ agent: "lead", task: "lead", skills: ["git"] }]);

    runner.startBatch([{ agent: "every", task: "a" }], { callerId: registry.list()[0].id, wait: false });
    await flushMicrotasks();

    expect(runtime.children[1].spec.skills).toEqual(["docs", "git"]);
    expect(registry.list()[1].skills).toEqual(["docs", "git"]);
  });

  it("stores each record's effective skills, all resolved to names, call-time skills added", async () => {
    const { run, registry } = setup({ lead: "tools: all\nskills: [docs]\nsubagents: [scout]" });

    await run([
      { agent: "general", task: "a" },
      { agent: "lead", task: "b", skills: ["git"] },
      { agent: "scout", task: "c" },
    ]);

    expect(registry.list().map((record) => record.skills)).toEqual([
      ["docs", "git", "tdd"],
      ["docs", "git"],
      [],
    ]);
  });

  it("lets an agent caller pass only skills in its own effective set", async () => {
    const { run, registry, runner, runtime } = setup({
      lead: "tools: all\nskills: [docs]\nsubagents: [scout]",
    });

    await run([{ agent: "lead", task: "lead", skills: ["git"] }]);

    const lead = registry.list()[0];

    expect(() =>
      runner.startBatch([{ agent: "scout", task: "a", skills: ["tdd"] }], { callerId: lead.id, wait: false }),
    ).toThrow(
      "scout: skill(s) \"tdd\" not in this caller's skills. This caller's skills: docs, git. Nothing was started.",
    );
    expect(registry.list()).toHaveLength(1);

    runner.startBatch([{ agent: "scout", task: "a", skills: ["git", "docs"] }], {
      callerId: lead.id,
      wait: false,
    });
    await flushMicrotasks();

    expect(runtime.children[1].spec.skills).toEqual(["git", "docs"]);
    expect(registry.list()[1].skills).toEqual(["git", "docs"]);
  });

  it("says an agent caller with skills: [] has no skills to pass", async () => {
    const { run, registry, runner } = setup({ bare: "tools: all\nskills: []\nsubagents: [scout]" });

    await run([{ agent: "bare", task: "lead" }]);

    expect(() =>
      runner.startBatch([{ agent: "scout", task: "a", skills: ["docs"] }], {
        callerId: registry.list()[0].id,
        wait: false,
      }),
    ).toThrow(
      'scout: skill(s) "docs" not in this caller\'s skills. This caller has no skills. Nothing was started.',
    );
  });

  it("carries the item's skills into a handoff successor", async () => {
    const { run, registry, runtime, host } = setup({}, { maxChainLength: 3 });

    await run([{ agent: "scout", task: "map", skills: ["tdd"] }]);
    host.settle();

    const first = registry.list()[0];
    const current = (id: string) => registry.get(id) as AgentRecord;

    runtime.child(first.id).turn({ tokens: first.contextLimit + 500, window: 1_000_000, percent: 20 });
    await flushMicrotasks();
    mkdirSync(dirname(first.handoffPath), { recursive: true });
    writeFileSync(
      first.handoffPath,
      "## Status\npartial\n\n## Outcome\n- x\n\n## Evidence\n- y\n\n## Blocker\nnone\n\n## Next\n- z\n\n## Files touched\nnone",
    );
    runtime.child(first.id).finish(first.handoffPath);
    await flushMicrotasks();

    const successor = current(first.id).successorId as string;

    expect(successor).toBeDefined();
    expect(runtime.child(successor).spec.skills).toEqual(["tdd"]);
    expect(current(successor).skills).toEqual(["tdd"]);
  });
});
