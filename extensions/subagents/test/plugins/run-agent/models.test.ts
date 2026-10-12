import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { catalogModel, flush } from "../../../../../core/test/helpers/fakes.ts";
import { agentDefinitionsPlugin } from "../../../src/plugins/agent-definitions/index.ts";
import { agentRegistryPlugin } from "../../../src/plugins/agent-registry/index.ts";
import { runAgentPlugin } from "../../../src/plugins/run-agent/index.ts";
import type { RunAgentDetails, RunAgentParams } from "../../../src/plugins/run-agent/tools.ts";
import { createHarness } from "../../helpers/harness.ts";

const setup = () => {
  const harness = createHarness([agentRegistryPlugin, agentDefinitionsPlugin, runAgentPlugin]);
  const runAgent = harness.host.tool<RunAgentParams, RunAgentDetails>("run_agent");

  const run = async (agents: RunAgentParams["agents"]) => {
    const result = await runAgent.execute({ agents }, { update: () => {} });

    await flush();

    return result;
  };

  return { ...harness, run, registry: harness.services.require("registry") };
};

describe("per-call model override", () => {
  it("runs the agent on the resolved model and echoes provider/id:thinking everywhere", async () => {
    const { run, runtime, registry } = setup();
    const result = await run([{ agent: "reviewer", task: "check", model: "hiaku:low" }]);
    const record = registry.list()[0];

    expect(runtime.children[0].spec).toMatchObject({ model: "anthropic/claude-haiku-5-5", thinking: "low" });
    expect(record.model).toBe("anthropic/claude-haiku-5-5:low");
    expect(result.text).toContain(`- ${record.id} (reviewer, anthropic/claude-haiku-5-5:low)`);
    expect(JSON.parse(readFileSync(join(record.dir, "manifest.json"), "utf8")).model).toBe(
      "anthropic/claude-haiku-5-5:low",
    );
  });

  it("runs on the main session's model and thinking without an override, and changes only thinking with :level", async () => {
    const { run, runtime, registry } = setup();

    await run([
      { agent: "reviewer", task: "a" },
      { agent: "reviewer", task: "b", model: ":low" },
      { agent: "reviewer", task: "c", model: "haiku" },
    ]);

    expect(runtime.children.map((child) => [child.spec.model, child.spec.thinking])).toEqual([
      ["fake/model", "medium"],
      ["fake/model", "low"],
      ["anthropic/claude-haiku-5-5", "medium"],
    ]);
    expect(registry.list().map((record) => record.model)).toEqual([
      "fake/model:medium",
      "fake/model:low",
      "anthropic/claude-haiku-5-5:medium",
    ]);
  });

  it("starts nothing and lists the candidates when one item's model is ambiguous", async () => {
    const { runtime, host, registry } = setup();
    const runAgent = host.tool<RunAgentParams, RunAgentDetails>("run_agent");

    const attempt = runAgent.execute(
      {
        agents: [
          { agent: "explorer", task: "a" },
          { agent: "reviewer", task: "b", model: "gpt-6" },
        ],
      },
      { update: () => {} },
    );

    await expect(attempt).rejects.toThrow(/reviewer: model "gpt-6" matches several model families/);
    await expect(attempt).rejects.toThrow(
      /- openai\/gpt-6.1-sol \(context 200.0k, \$1\/\$5 per Mtok in\/out\)/,
    );
    await expect(attempt).rejects.toThrow(/Nothing was started\.$/);
    expect(runtime.children).toEqual([]);
    expect(registry.list()).toEqual([]);
  });

  it("reports models whose provider has no credentials and an invalid thinking level", async () => {
    const { runtime, host } = setup();
    const runAgent = host.tool<RunAgentParams, RunAgentDetails>("run_agent");

    runtime.catalog = runtime.catalog.filter((model) => model.provider !== "anthropic");

    await expect(
      runAgent.execute({ agents: [{ agent: "reviewer", task: "b", model: "haiku" }] }, { update: () => {} }),
    ).rejects.toThrow(/matches only models whose providers have no credentials \(locked\)/);
    await expect(
      runAgent.execute(
        { agents: [{ agent: "reviewer", task: "b", model: "luna:hgih" }] },
        { update: () => {} },
      ),
    ).rejects.toThrow(/invalid thinking level "hgih"/);
    await expect(
      runAgent.execute(
        { agents: [{ agent: "reviewer", task: "b", model: "locked/claude-haiku-9-0" }] },
        { update: () => {} },
      ),
    ).rejects.toThrow(/provider "locked" has no credentials/);
    expect(runtime.children).toEqual([]);
  });

  it("rejects an agent file whose model provider has no credentials before spawning", async () => {
    const { runtime, host, services } = setup();
    const dir = join(host.info.agentDir, "agents");

    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "locked.md"),
      "---\nname: locked\ndescription: d\nmodel: locked/claude-haiku-9-0\nlimit: 50000\ntools: all\nskills: all\nsubagents: []\n---\n",
    );
    services.require("definitions").reload();

    await expect(
      host
        .tool<RunAgentParams, RunAgentDetails>("run_agent")
        .execute({ agents: [{ agent: "locked", task: "x" }] }, { update: () => {} }),
    ).rejects.toThrow(/locked: model "locked\/claude-haiku-9-0": provider "locked" has no credentials/);
    expect(runtime.children).toEqual([]);
  });

  it("picks the preferred provider when several providers share an id", async () => {
    const { run, runtime } = setup();

    runtime.catalog.push(catalogModel("zeta/gpt-6-luna"));
    runtime.preferences = { sessionProvider: "fake", defaultProvider: "zeta" };

    await run([{ agent: "explorer", task: "a", model: "gpt-6-luna" }]);

    expect(runtime.children[0].spec.model).toBe("zeta/gpt-6-luna");
  });
});
