import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { flushMicrotasks } from "../../../../../test-framework/index.ts";
import { agentDefinitionsPlugin } from "../../../src/plugins/agent-definitions/index.ts";
import { agentRegistryPlugin } from "../../../src/plugins/agent-registry/index.ts";
import { limitsPlugin } from "../../../src/plugins/limits/index.ts";
import { runAgentPlugin } from "../../../src/plugins/run-agent/index.ts";
import type { RunAgentDetails, RunAgentParams } from "../../../src/plugins/run-agent/render.ts";
import { createHarness } from "../../support/subagents-harness.ts";

describe("run_agent mcp", () => {
  it("passes the definition's mcp to the spawn, true when the file omits it", async () => {
    const harness = createHarness([
      agentRegistryPlugin,
      agentDefinitionsPlugin,
      runAgentPlugin,
      limitsPlugin,
    ]);
    const dir = join(harness.host.info.agentDir, "agents");

    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "own.md"),
      "---\nname: own\ndescription: d\nlimit: 50000\ntools: all\nskills: []\nsubagents: []\n---\n",
    );
    harness.host.start();
    harness.host.idle = false;

    await harness.host.tool<RunAgentParams, RunAgentDetails>("run_agent").execute(
      {
        agents: [
          { agent: "scout", task: "a" },
          { agent: "general", task: "b" },
          { agent: "own", task: "c" },
        ],
      },
      { update: () => {} },
    );
    await flushMicrotasks();

    const registry = harness.services.require("registry");
    const byAgent = Object.fromEntries(
      harness.runtime.children.map((child) => [registry.get(child.id)?.agent, child.spec.mcp ?? true]),
    );

    expect(byAgent).toEqual({ scout: false, general: true, own: true });
  });
});
