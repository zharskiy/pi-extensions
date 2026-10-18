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
      '- Choosing: pick the agent whose description fits the work, never because a model was named. "Review X with model M" is the reviewing agent with a model override.',
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

  it("states the skills rule, the credentials case and the Status lines of a result, without the old Tasks rule", () => {
    const text = describeRunAgent(agents, { callerDepth: 1, maxDepth: 3, maxConcurrent: 4 });

    expect(text).toContain(
      "- Skills: `skills` adds skills, by name, to the agent's own for this task. Pass skills you have yourself (in the main session, any of its skills) whose descriptions fit the task, plus any skill the user named; chores (scout, editor, fetch, shell, image, verifier) take none. A skill you do not have starts nothing, and the error lists yours.",
    );
    expect(text).toContain(
      "Pass the words unchanged as `name[:thinking]` (a name, a name with `:high`, or `:low` alone).",
    );
    expect(text).toContain(
      "If the only matches lack credentials, tell the user (they can log in with `/login`) and ask whether to run the agent on its own model; never drop a requested model silently.",
    );
    expect(text).toContain(
      "It starts with `Status: done`, `Status: partial` (its Open line says what is left) or `Status: blocked` (it changed nothing; either the task was ambiguous and it lists the questions, or a `Wrong agent:` line says the task belongs to another agent: start that one with the same task), and ends with `Verification:` and `Open:` lines.",
    );
    expect(text).not.toContain("- Tasks:");
    expect(text).not.toContain("Read the file either way");
    expect(text).toContain("after the path). To continue, start a new agent");
  });

  it("adds the Cap line only when a child cap is given, after the depth rule", () => {
    const main = describeRunAgent(agents, { callerDepth: 1, maxDepth: 3, maxConcurrent: 4 });
    const child = describeRunAgent(agents, { callerDepth: 2, maxDepth: 3, maxConcurrent: 4, childCap: 6 });

    expect(main).not.toContain("- Cap:");
    expect(child).toContain(
      "They cannot start agents of their own.\n- Cap: you may start at most 6 agents in this run, across all your batches; further calls are refused. Do not start an agent for work of a few tool calls.\n- Concurrency:",
    );
  });

  it("is stable for the same input so the tool set stays cache-safe", () => {
    const limits = { callerDepth: 1, maxDepth: 2, maxConcurrent: 4 };
    const all = [general, ...agents];

    expect(describeRunAgent(all, limits)).toBe(describeRunAgent([...all].reverse(), limits));
  });
});
