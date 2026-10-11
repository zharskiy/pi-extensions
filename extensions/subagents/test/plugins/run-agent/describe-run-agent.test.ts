import { describe, expect, it } from "vitest";
import { describeRunAgent } from "../../../src/plugins/run-agent/tools.ts";

const agents = [
  {
    name: "reviewer",
    description: "Reviews a change.",
    limit: 80000,
    model: "openai/gpt-6-luna",
    thinking: "high",
  },
  { name: "explorer", description: "Searches the repo.", limit: 100000 },
];

const general = {
  name: "general",
  description: "Fallback work.",
  limit: 100000,
  model: "openai/gpt-6.1-sol",
  fallback: true,
  subagents: ["explorer", "reviewer"],
};

describe("run_agent description", () => {
  it("lists the allowed agents with their models and limits, the rules and the result contract", () => {
    const text = describeRunAgent(agents, { callerDepth: 1, maxDepth: 3, maxConcurrent: 4 });

    expect(text).toContain(
      "- explorer: Searches the repo. (model of the main session, context limit 100000 tokens)\n- reviewer: Reviews a change. (model openai/gpt-6-luna:high, context limit 80000 tokens)",
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

  it("lists fallback agents in their own block after the role agents, with what they may start", () => {
    const text = describeRunAgent([general, ...agents], { callerDepth: 1, maxDepth: 3, maxConcurrent: 4 });
    const roles = text.indexOf("- explorer:");
    const fallback = text.indexOf("Fallback agents (only when no agent above fits the work):\n- general:");

    expect(roles).toBeGreaterThan(0);
    expect(fallback).toBeGreaterThan(roles);
    expect(text).toContain(
      "- general: Fallback work. (model openai/gpt-6.1-sol, context limit 100000 tokens, may start explorer, reviewer)",
    );
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
