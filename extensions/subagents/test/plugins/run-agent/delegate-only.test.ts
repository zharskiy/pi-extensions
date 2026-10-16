import { describe, expect, it } from "vitest";
import { flush } from "../../../../../core/test/helpers/fakes.ts";
import { agentDefinitionsPlugin } from "../../../src/plugins/agent-definitions/index.ts";
import { agentRegistryPlugin } from "../../../src/plugins/agent-registry/index.ts";
import { agentStatusPlugin } from "../../../src/plugins/agent-status/index.ts";
import { runAgentPlugin } from "../../../src/plugins/run-agent/index.ts";
import type { RunAgentDetails, RunAgentParams } from "../../../src/plugins/run-agent/render.ts";
import { createHarness } from "../../helpers/harness.ts";

const setup = (overrides = {}) =>
  createHarness([agentRegistryPlugin, agentDefinitionsPlugin, agentStatusPlugin, runAgentPlugin], overrides);

describe("delegate-only main session", () => {
  it("keeps the agent tools and the configured tools when on", () => {
    const { host } = setup();

    expect(host.restrictCalls).toEqual([
      ["run_agent", "message_agent", "agent_status", "read", "write", "questionnaire"],
    ]);
  });

  it("uses the configured tool list", () => {
    const { host } = setup({ delegateOnlyTools: ["read"] });

    expect(host.restrictCalls).toEqual([["run_agent", "message_agent", "agent_status", "read"]]);
  });

  it("does not restrict when off", () => {
    const { host } = setup({ delegateOnly: false });

    expect(host.restrictCalls).toEqual([]);
  });

  it("leaves out agent_status when its plugin is disabled", () => {
    const { host } = setup({ disabledPlugins: ["agent-status"] });

    expect(host.restrictCalls).toEqual([["run_agent", "message_agent", "read", "write", "questionnaire"]]);
  });

  it("never restricts for children", async () => {
    const { host, runtime } = setup();

    host.idle = false;

    await host
      .tool<RunAgentParams, RunAgentDetails>("run_agent")
      .execute({ agents: [{ agent: "general", task: "lead" }] }, { update: () => {} });
    await flush();

    expect(runtime.children).toHaveLength(1);
    expect(host.restrictCalls).toHaveLength(1);
  });
});
