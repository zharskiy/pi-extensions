import type { ToolSpec } from "../../../../../core/adapter/contract.ts";
import { type AgentFrontmatter, ALL } from "../../model/agent-schema.ts";
import {
  type AgentInternals,
  type AgentRegistry,
  grantText,
  isNone,
  MAIN_CALLER,
} from "../../model/types.ts";
import {
  type BlockHints,
  blockTone,
  type RunAgentDetails,
  type RunAgentParams,
  renderBlock,
} from "./render.ts";
import type { Runner } from "./runner.ts";

export type MessageAgentParams = { id: string; message: string };

type PendingCalls = {
  set(callerId: string, toolCallId: string, details: RunAgentDetails): void;
  get(owner: string, toolCallId: string): RunAgentDetails | undefined;
  delete(callerId: string, toolCallId: string): void;
  clear(): void;
};

const callKey = (callerId: string, toolCallId: string) => `${callerId}\n${toolCallId}`;

export const createPendingCalls = (): PendingCalls => {
  const calls = new Map<string, RunAgentDetails>();

  return {
    set: (callerId, toolCallId, details) => {
      calls.set(callKey(callerId, toolCallId), details);
    },
    get: (owner, toolCallId) => calls.get(callKey(owner, toolCallId)),
    delete: (callerId, toolCallId) => {
      calls.delete(callKey(callerId, toolCallId));
    },
    clear: () => {
      calls.clear();
    },
  };
};

type ToolDeps = {
  runner: Runner;
  registry: AgentRegistry;
  calls: PendingCalls;
  hints: BlockHints;
  onRendered?: (batchId: string, invalidate: () => void) => void;
};

type DelegateAgent = Pick<AgentFrontmatter, "name" | "description" | "limit"> &
  Partial<Pick<AgentFrontmatter, "model" | "subagents">> &
  Pick<AgentInternals, "thinking">;

export type RunAgentLimits = {
  callerDepth: number;
  maxDepth: number;
  maxConcurrent: number;
  childCap?: number;
};

const modelText = (agent: DelegateAgent) => {
  const thinking = agent.thinking ? `:${agent.thinking}` : "";

  return agent.model ? `model ${agent.model}${thinking}` : `model of the main session${thinking}`;
};

const agentLine = (agent: DelegateAgent, limits: RunAgentLimits) => {
  const nested = agent.subagents ?? [];
  const canNest = !isNone(nested) && limits.callerDepth + 1 < limits.maxDepth;
  const spawns = canNest ? `, may start ${nested === ALL ? "any other agent" : grantText(nested)}` : "";

  return `- ${agent.name}: ${agent.description} (${modelText(agent)}, context limit ${agent.limit} tokens${spawns})`;
};

const agentList = (agents: DelegateAgent[], limits: RunAgentLimits) => {
  if (agents.length === 0) {
    return "- none: no agents are available to you; do not call this tool.";
  }

  return agents
    .toSorted((left, right) => left.name.localeCompare(right.name))
    .map((agent) => agentLine(agent, limits))
    .join("\n");
};

const depthRule = ({ callerDepth, maxDepth }: RunAgentLimits) => {
  const childDepth = callerDepth + 1;
  const nesting =
    childDepth >= maxDepth
      ? "They cannot start agents of their own."
      : "They may start only the subagents their own definition allows.";

  return `- Depth: you run at depth ${callerDepth}; agents you start run at depth ${childDepth} of at most ${maxDepth}. ${nesting}`;
};

const capRule = ({ childCap }: RunAgentLimits) =>
  childCap === undefined
    ? []
    : [
        `- Cap: you may start at most ${childCap} agents in this run, across all your batches; further calls are refused. Do not start an agent for work of a few tool calls.`,
      ];

export const describeRunAgent = (allowedAgents: DelegateAgent[], limits: RunAgentLimits): string =>
  [
    "Start one or more background agents as one batch. Each agent gets its own context window, works alone with no access to this conversation, and returns one result. By default the call returns at once with agent ids and you are woken once, with every result of the batch, when all of its agents are done; after starting such a batch, end your turn. With `wait: true` the call blocks until the batch is done and returns its results.",
    "Agents you may start:",
    agentList(allowedAgents, limits),
    [
      "Rules:",
      '- Choosing: pick the agent whose description fits the work, never because a model was named. "Review X with model M" is the reviewing agent with a model override.',
      "- Model: each agent runs on the model shown next to it. Set `model` only when the user (or, for an agent, its task) explicitly names a model or thinking level for this work; never choose or change a model yourself, for cost, speed or any other reason. Pass the words unchanged as `name[:thinking]` (a name, a name with `:high`, or `:low` alone). The harness resolves the name, tolerating misspellings and picking the newest version, and reports the model it runs. If it reports an ambiguous or unknown model, nothing was started: ask the user with the listed candidates and reuse the answer for the rest of the conversation. If the only matches lack credentials, tell the user (they can log in with `/login`) and ask whether to run the agent on its own model; never drop a requested model silently.",
      "- Skills: `skills` adds skills, by name, to the agent's own for this task. Pass skills you have yourself (in the main session, any of its skills) whose descriptions fit the task, plus any skill the user named; chores (scout, fetch, shell, image) take none. A skill you do not have starts nothing, and the error lists yours.",
      depthRule(limits),
      ...capRule(limits),
      `- Concurrency: at most ${limits.maxConcurrent} agents run at the same time across the whole tree; extra agents wait in a queue.`,
      "- Context limit: an agent that reaches its context limit writes a handoff file. When the handoff says the work is partial, the harness starts a successor from it in the same batch on its own; you are not woken and the chain counts as one agent. Only when the chain cap is reached or the handoff says blocked does the agent end as handoff.",
      "- Batches: put independent tasks in one call so they run in parallel. Run a dependent task in a later call, after the results it depends on have arrived.",
    ].join("\n"),
    [
      "Result contract: one message per batch with one section per agent, headed `## <id> (<agent>) - <state>`.",
      "- done: the result follows inline; when it is large only its head is inline and a last line `Result file: <path> (<N> more chars)` points to the full text. A `(shape: no Status line)` note means it does not follow the shape below. It starts with `Status: done`, `Status: partial` (its Open line says what is left) or `Status: blocked` (it changed nothing; either the task was ambiguous and it lists the questions, or a `Wrong agent:` line says the task belongs to another agent: start that one with the same task), and ends with `Verification:` and `Open:` lines.",
      "- failed: the reason, plus the agent's last output under an `(unverified partial output: <reason>)` note when it had any; it is not a result.",
      "- stopped: the reason, plus the agent's last output under an `(unverified partial output: <reason>)` note when it had any.",
      "- handoff: `Handoff file: <path>`; the agent ran out of context before finishing and could not be continued automatically (blocked, the chain cap was reached, or the file does not follow the handoff schema, shown as `(invalid: <reasons>)` after the path). To continue, start a new agent and pass the handoff file in `files`.",
      "- A `Chain: <id> → <id> (N sessions)` line means the agent continued itself from handoffs; the section carries the last session's id and the totals of all sessions. Any id of the chain works with `message_agent` and `agent_status`.",
    ].join("\n"),
  ].join("\n\n");

const runAgentParameters = {
  type: "object",
  properties: {
    agents: {
      type: "array",
      minItems: 1,
      description:
        "Agents to start as one batch. They run in parallel; you are woken once when all are done.",
      items: {
        type: "object",
        properties: {
          agent: { type: "string", description: "Agent name from the list in this tool's description." },
          task: {
            type: "string",
            description:
              "Self-contained brief with one line each: Goal, User's words, Known, Where to look, Scope, Done when, Return.",
          },
          description: {
            type: "string",
            description: "Short label (3-6 words); it names the agent in the panel and the transcript.",
          },
          files: {
            type: "array",
            items: { type: "string" },
            description: "Input files the agent should read first.",
          },
          model: {
            type: "string",
            description:
              "Only when the user explicitly named a model or thinking level for this task: their words as `name[:thinking]`, for example `provider/id`, a short model name, `name:high`, or `:low` to change only the thinking level. Omit to use the agent's own model.",
          },
          skills: {
            type: "array",
            items: { type: "string" },
            description:
              "Skill names to add for this agent: skills you have whose descriptions fit the task, plus any the user named. None for chores. A skill you do not have starts nothing; the error lists yours.",
          },
        },
        required: ["agent", "task"],
        additionalProperties: false,
      },
    },
    wait: {
      type: "boolean",
      description: "Block until the batch is done and return results directly. Default false (background).",
    },
  },
  required: ["agents"],
  additionalProperties: false,
};

const messageAgentParameters = {
  type: "object",
  properties: {
    id: { type: "string", description: "Id of an agent you started." },
    message: { type: "string", description: "Correction or extra instruction for the running agent." },
  },
  required: ["id", "message"],
  additionalProperties: false,
};

export const runAgentTool = (
  deps: ToolDeps,
  description: string,
  callerId: string = MAIN_CALLER,
): ToolSpec<RunAgentParams, RunAgentDetails> => ({
  name: "run_agent",
  label: "Run agent",
  description,
  promptSnippet: "delegate tasks to background agents (parallel batch, one wake when all are done)",
  parameters: runAgentParameters,
  renderShell: "box",
  execute: async (params, ctx) => {
    const started = deps.runner.startBatch(params.agents, { callerId, wait: params.wait === true });

    const details: RunAgentDetails = {
      batchId: started.batchId,
      ids: started.records.map((record) => record.id),
      agents: started.records.map((record) => ({
        id: record.id,
        agent: record.agent,
        description: record.description,
        model: record.model,
      })),
    };

    const pending = callerId !== MAIN_CALLER && ctx.toolCallId ? ctx.toolCallId : undefined;

    if (pending) {
      deps.calls.set(callerId, pending, details);
    }

    try {
      ctx.update("", details);

      if (params.wait !== true) {
        const list = started.records
          .map((record) => `- ${record.id} (${record.agent}, ${record.model ?? "model n/a"})`)
          .join("\n");
        const text = `Started batch ${started.batchId}:\n${list}\nYou will be woken once when all agents are done. End your turn now.`;

        return { text, details };
      }

      const onAbort = () => {
        details.ids.forEach((id) => {
          void deps.runner.stop(id, { immediate: true });
        });
      };

      ctx.signal?.addEventListener("abort", onAbort, { once: true });

      await started.settled;

      ctx.signal?.removeEventListener("abort", onAbort);

      return { text: deps.runner.batchText(started.batchId), details };
    } finally {
      if (pending) {
        deps.calls.delete(callerId, pending);
      }
    }
  },
  renderCall: () => "",
  renderResult: (result, state, theme) => {
    if (result.details?.batchId) {
      deps.onRendered?.(result.details.batchId, state.invalidate);
    }

    return renderBlock({
      params: state.args as RunAgentParams | undefined,
      result,
      state,
      registry: deps.registry,
      theme,
      hints: deps.hints,
    });
  },
  renderTone: (state, result) => blockTone(deps.registry, state, result),
  pendingResult: (toolCallId, owner) => {
    const details = owner === undefined ? undefined : deps.calls.get(owner, toolCallId);

    return details ? { text: "", details } : undefined;
  },
});

export const messageAgentTool = (
  deps: Pick<ToolDeps, "runner" | "registry">,
  callerId: string = MAIN_CALLER,
): ToolSpec<MessageAgentParams, { delivery?: string }> => ({
  name: "message_agent",
  label: "Message agent",
  description:
    "Send a correction or extra instruction to a running agent you started. Returns immediately; the agent does not reply. Its result reflects the message.",
  promptSnippet: "forward a user correction to a running agent you started",
  parameters: messageAgentParameters,
  execute: async (params) => {
    const record = deps.registry.get(params.id);

    if (!record) {
      return { text: `Error: unknown agent "${params.id}".`, isError: true };
    }

    if (record.callerId !== callerId) {
      return { text: `Error: only the caller that started ${params.id} may message it.`, isError: true };
    }

    const routed = await deps.runner.route(params.id, { sender: callerId, text: params.message });

    if (!routed.ok) {
      return { text: `Error: ${routed.error}`, isError: true };
    }

    return {
      text: `Message delivered to ${params.id} (${routed.delivery}).`,
      details: { delivery: routed.delivery },
    };
  },
  renderCall: (params, theme) =>
    `${theme.bold("message_agent")} ${theme.fg("accent", params.id ?? "")} ${theme.fg("muted", (params.message ?? "").slice(0, 60))}`,
});
