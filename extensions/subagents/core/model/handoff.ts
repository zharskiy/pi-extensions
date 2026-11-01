import {
  type HandoffAudience,
  handoffInstruction,
  validateHandoff,
} from "../../../../platform/shared/index.ts";

const AGENT_AUDIENCE: HandoffAudience = {
  statuses: ["partial", "blocked"],
  statusHint: "",
  reader: "the agent that continues this work",
  extraRules: [
    "Batches you started that are still running keep running, and the handoff waits for them: list each under Evidence with its batch id, the question it answers and what its result is for, and put that use under Next. Results that arrive later are attached to your successor's task.",
  ],
  nextHint: "",
};

const AGENT_REASON = "You have reached your context limit. Stop the current work now and hand it off.";

type ChainLink = { id: string; link: number; path: string };

export const handoffService = {
  instruction: (path: string) => handoffInstruction({ path, reason: AGENT_REASON, audience: AGENT_AUDIENCE }),
  validate: (text: string) => validateHandoff(text, AGENT_AUDIENCE.statuses),
  preface: ({ id, link, path }: ChainLink) =>
    `You continue the work of agent ${id} as link ${link} of its chain; it reached its context limit and wrote the handoff below (also saved at ${path}). Carry on from its Next section without redoing the work it reports as done.`,
};
