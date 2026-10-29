import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { catalogModel, flushMicrotasks } from "../../../../../test/framework/index.ts";
import { agentDefinitionsPlugin } from "../../../api/plugins/agent-definitions.ts";
import { agentRegistryPlugin } from "../../../api/plugins/agent-registry.ts";
import { runAgentPlugin } from "../../../api/plugins/run-agent.ts";
import type { RunAgentDetails, RunAgentParams } from "../../../core/run-agent/tools.ts";
import { createHarness } from "../../support/subagents-harness.ts";

const setup = () => {
  const harness = createHarness([agentRegistryPlugin, agentDefinitionsPlugin, runAgentPlugin]);
  const runAgent = harness.host.tool<RunAgentParams, RunAgentDetails>("run_agent");

  const run = async (agents: RunAgentParams["agents"]) => {
    const result = await runAgent.execute({ agents }, {});

    await flushMicrotasks();

    return result;
  };

  return { ...harness, run, registry: harness.services.require("registry") };
};

describe("per-call model override", () => {
  it("runs the agent on the resolved model and echoes provider/id:thinking everywhere", async () => {
    const { run, runtime, registry } = setup();
    const result = await run([{ agent: "reviewer", task: "check", model: "lyar:low" }]);
    const record = registry.list()[0];

    expect(runtime.children[0].spec).toMatchObject({ model: "acme/lyra-5-5", thinking: "low" });
    expect(record.model).toBe("acme/lyra-5-5:low");
    expect(result.text).toContain(`- ${record.id} (reviewer, acme/lyra-5-5:low)`);
    expect(JSON.parse(readFileSync(join(record.dir, "manifest.json"), "utf8")).model).toBe(
      "acme/lyra-5-5:low",
    );
  });

  it("keeps the agent's own model and thinking without an override, and changes only thinking with :level", async () => {
    const { run, runtime, registry, services } = setup();
    const own = services.require("definitions").get("reviewer")?.model;

    await run([
      { agent: "reviewer", task: "a" },
      { agent: "reviewer", task: "b", model: ":low" },
      { agent: "reviewer", task: "c", model: "lyra" },
    ]);

    expect(runtime.children.map((child) => [child.spec.model, child.spec.thinking])).toEqual([
      [own, "high"],
      [own, "low"],
      ["acme/lyra-5-5", "high"],
    ]);
    expect(registry.list().map((record) => record.model)).toEqual([
      `${own}:high`,
      `${own}:low`,
      "acme/lyra-5-5:high",
    ]);
  });

  it("runs an agent file without a model line on the main session's model and thinking", async () => {
    const { run, runtime, host } = setup();
    const dir = join(host.info.agentDir, "agents");

    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "plain.md"),
      "---\nname: plain\ndescription: d\nlimit: 50000\ntools: all\nskills: all\nsubagents: []\n---\n",
    );
    host.start();

    await run([{ agent: "plain", task: "a" }]);

    expect(runtime.children[0].spec).toMatchObject({ model: "fake/model", thinking: "medium" });
  });

  it("takes the thinking level from a provider/id:level in the frontmatter or the per-call model override", async () => {
    const { run, runtime, host } = setup();
    const dir = join(host.info.agentDir, "agents");

    runtime.catalog.push(catalogModel("acme/model-a"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "tuned.md"),
      "---\nname: tuned\ndescription: d\nmodel: acme/model-a:minimal\nlimit: 50000\ntools: all\nskills: all\nsubagents: []\n---\n",
    );
    host.start();

    await run([
      { agent: "tuned", task: "a" },
      { agent: "tuned", task: "b", model: "acme/model-a:xhigh" },
    ]);

    expect(runtime.children.map((child) => [child.spec.model, child.spec.thinking])).toEqual([
      ["acme/model-a", "minimal"],
      ["acme/model-a", "xhigh"],
    ]);
  });

  it("starts nothing and lists the candidates when one item's model is ambiguous", async () => {
    const { runtime, host, registry } = setup();
    const runAgent = host.tool<RunAgentParams, RunAgentDetails>("run_agent");

    const attempt = runAgent.execute(
      {
        agents: [
          { agent: "scout", task: "a" },
          { agent: "reviewer", task: "b", model: "nova-6" },
        ],
      },
      {},
    );

    await expect(attempt).rejects.toThrow(/reviewer: model "nova-6": matches several models \(/);
    await expect(attempt).rejects.toThrow(
      /- beta\/nova-6.1-sol \(context 200.0k, \$1\/\$5 per Mtok in\/out\)/,
    );
    await expect(attempt).rejects.toThrow(/Nothing was started\.$/);
    expect(runtime.children).toEqual([]);
    expect(registry.list()).toEqual([]);
  });

  it("reports models whose provider has no credentials and an invalid thinking level", async () => {
    const { runtime, host } = setup();
    const runAgent = host.tool<RunAgentParams, RunAgentDetails>("run_agent");

    runtime.catalog = runtime.catalog.filter((model) => model.provider !== "acme");

    await expect(
      runAgent.execute({ agents: [{ agent: "reviewer", task: "b", model: "lyra" }] }, {}),
    ).rejects.toThrow(/matches only models without credentials \(locked\//);
    await expect(
      runAgent.execute({ agents: [{ agent: "reviewer", task: "b", model: "luna:hgih" }] }, {}),
    ).rejects.toThrow(/invalid thinking level "hgih"/);
    await expect(
      runAgent.execute({ agents: [{ agent: "reviewer", task: "b", model: "locked/lyra-9-0" }] }, {}),
    ).rejects.toThrow(/provider "locked" has no credentials/);
    expect(runtime.children).toEqual([]);
  });

  it("rejects an agent file whose model provider has no credentials before spawning", async () => {
    const { runtime, host } = setup();
    const dir = join(host.info.agentDir, "agents");

    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "locked.md"),
      "---\nname: locked\ndescription: d\nmodel: locked/lyra-9-0\nlimit: 50000\ntools: all\nskills: all\nsubagents: []\n---\n",
    );
    host.start();

    await expect(
      host
        .tool<RunAgentParams, RunAgentDetails>("run_agent")
        .execute({ agents: [{ agent: "locked", task: "x" }] }, {}),
    ).rejects.toThrow(/locked: model "locked\/lyra-9-0": provider "locked" has no credentials/);
    expect(runtime.children).toEqual([]);
  });

  it("picks the preferred provider when several providers share an id", async () => {
    const { run, runtime } = setup();

    runtime.catalog.push(catalogModel("zeta/nova-6-luna"));
    runtime.preferences = { sessionProvider: "fake", defaultProvider: "zeta" };

    await run([{ agent: "scout", task: "a", model: "nova-6-luna" }]);

    expect(runtime.children[0].spec.model).toBe("zeta/nova-6-luna");
  });
});
