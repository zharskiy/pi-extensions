import { describe, expect, it } from "vitest";
import { describeRunAgent } from "../../../src/plugins/run-agent/tools.ts";

const agents = [
  {
    name: "reviewer",
    description: "Reviews a change.",
    limit: 80000,
    model: "beta/nova-6-luna",
    thinking: "high",
  },
  { name: "explorer", description: "Searches the repo.", limit: 100000 },
];

const general = {
  name: "general",
  description: "Use only when no other agent fits the work.",
  limit: 100000,
  model: "beta/nova-6.1-sol",
  subagents: ["explorer", "reviewer"],
};

describe("run_agent description", () => {
  it("lists the allowed agents with their models and limits, the rules and the result contract", () => {
    const text = describeRunAgent(agents, { callerDepth: 1, maxDepth: 3, maxConcurrent: 4 });

    expect(text).toContain(
      "- explorer: Searches the repo. (model of the main session, context limit 100000 tokens)\n- reviewer: Reviews a change. (model beta/nova-6-luna:high, context limit 80000 tokens)",
    );
    expect(text).toContain("agents you start run at depth 2 of at most 3. They may start only the subagents");
    expect(text).toContain("at most 4 agents run at the same time");
    expect(text).toContain(
      "Set `model` only when the user (or, for an agent, its task) explicitly names a model",
    );
    expect(text).toContain("never choose or change a model yourself");
    expect(text).toContain("`Status: blocked`");
    expect(text).toContain("handoff: `Handoff file: <path>`");
  });

  it("lists every agent the same way, by name, with what it may start", () => {
    const text = describeRunAgent([general, ...agents], { callerDepth: 1, maxDepth: 3, maxConcurrent: 4 });

    expect(text).toContain(
      "Agents you may start:\n\n- explorer: Searches the repo. (model of the main session, context limit 100000 tokens)\n- general: Use only when no other agent fits the work. (model beta/nova-6.1-sol, context limit 100000 tokens, may start explorer, reviewer)\n- reviewer: ",
    );
    expect(text).not.toContain("allback");
    expect(text).toContain(
      "- Choosing: pick the agent whose description fits the work, never because a model was named; when the request names no role, work out the role from the work.",
    );
  });

  it("says any other agent for subagents: all and lists no MCP tools", () => {
    const lead = {
      ...general,
      name: "lead",
      subagents: "all" as const,
    };
    const text = describeRunAgent([lead, ...agents], { callerDepth: 1, maxDepth: 3, maxConcurrent: 4 });

    expect(text).toContain(
      "- lead: Use only when no other agent fits the work. (model beta/nova-6.1-sol, context limit 100000 tokens, may start any other agent)\n",
    );
    expect(text).not.toContain("MCP");
  });

  it("does not promise nesting when the agents run at the depth cap", () => {
    const text = describeRunAgent([general], { callerDepth: 1, maxDepth: 2, maxConcurrent: 4 });

    expect(text).not.toContain("may start explorer");
    expect(text).toContain("They cannot start agents of their own.");
  });

  it("tells the last level that its agents cannot nest and handles an empty list", () => {
    const text = describeRunAgent([], { callerDepth: 2, maxDepth: 3, maxConcurrent: 2 });

    expect(text).toContain("They cannot start agents of their own.");
    expect(text).toContain("- none: no agents are available to you; do not call this tool.");
  });

  it("is stable for the same input so the tool set stays cache-safe", () => {
    const limits = { callerDepth: 1, maxDepth: 2, maxConcurrent: 4 };
    const all = [general, ...agents];

    expect(describeRunAgent(all, limits)).toBe(describeRunAgent([...all].reverse(), limits));
  });
});
