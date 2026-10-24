import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { flushMicrotasks } from "../../../../../test-framework/index.ts";
import type { RunAgentDetails, RunAgentParams } from "../../../core/run-agent/tools.ts";
import { agentDefinitionsPlugin } from "../../../src/plugins/agent-definitions/index.ts";
import { agentRegistryPlugin } from "../../../src/plugins/agent-registry/index.ts";
import { fetchToolPlugin } from "../../../src/plugins/fetch-tool/index.ts";
import { runAgentPlugin } from "../../../src/plugins/run-agent/index.ts";
import { createHarness } from "../../support/subagents-harness.ts";

const definition = (name: string, tools: string) =>
  `---\nname: ${name}\ndescription: d\nlimit: 50000\nsubagents: [scout]\nskills: []\nworktree: false\ntools: ${tools}\n---\n`;

const setup = async (tools: string, overrides = {}) => {
  const harness = createHarness(
    [agentRegistryPlugin, agentDefinitionsPlugin, fetchToolPlugin, runAgentPlugin],
    { overrides },
  );
  const dir = join(harness.host.info.agentDir, "agents");

  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "worker.md"), definition("worker", tools));
  harness.host.start();
  harness.host.idle = false;

  await harness.host
    .tool<RunAgentParams, RunAgentDetails>("run_agent")
    .execute({ agents: [{ agent: "worker", task: "go" }] }, { update: () => {} });
  await flushMicrotasks();

  return harness.runtime.children[0].spec.customTools ?? [];
};

const names = (tools: { name: string }[]) => tools.map((tool) => tool.name);

describe("fetch grant", () => {
  it("gives fetch to an agent whose tools list names it", async () => {
    expect(names(await setup("[read, fetch]"))).toContain("fetch");
  });

  it("does not give fetch for all", async () => {
    expect(names(await setup("all"))).not.toContain("fetch");
  });

  it("does not give fetch for a list without it", async () => {
    expect(names(await setup("[read, bash]"))).not.toContain("fetch");
  });

  it("does not give fetch when the plugin is disabled", async () => {
    expect(names(await setup("[fetch]", { disabledPlugins: ["fetch-tool"] }))).not.toContain("fetch");
  });

  it("puts the Cap line in the child's run_agent description", async () => {
    const tools = await setup("[fetch]", { maxChildrenPerAgent: 4 });
    const description = tools.find((tool) => tool.name === "run_agent")?.description;

    expect(description).toContain("- Cap: you may start at most 4 agents in this run");
  });
});
