import type { ModelChoice, ModelResolution } from "../../../../../core/adapter/contract.ts";
import { formatTokens } from "../../components/agent-row.ts";

const choiceLine = (choice: ModelChoice) =>
  `- ${choice.ref} (context ${formatTokens(choice.contextWindow)}, $${choice.cost.input}/$${choice.cost.output} per Mtok in/out)`;

const choiceList = (choices: ModelChoice[]) => choices.map(choiceLine).join("\n");

const providersOf = (choices: ModelChoice[]) =>
  Array.from(new Set(choices.map((choice) => choice.ref.slice(0, choice.ref.indexOf("/"))))).join(", ");

export const resolutionError = (
  agent: string,
  resolution: Exclude<ModelResolution, { kind: "resolved" }>,
) => {
  const head = `${agent}: model "${resolution.request}"`;

  if (resolution.kind === "invalid") {
    return `${head}: ${resolution.error}.`;
  }

  if (resolution.kind === "ambiguous") {
    return `${head} matches several model families. Ask the user which one to use, then call run_agent again with that provider/id:\n${choiceList(resolution.candidates)}`;
  }

  if (resolution.withoutCredentials.length > 0) {
    return `${head} matches only models whose providers have no credentials (${providersOf(resolution.withoutCredentials)}). Tell the user; they can log in with /login, or the agent can run on its own model:\n${choiceList(resolution.withoutCredentials)}`;
  }

  if (resolution.candidates.length === 0) {
    return `${head} matches no available model. Ask the user for the model name.`;
  }

  return `${head} matches no available model. Did you mean one of these? Ask the user:\n${choiceList(resolution.candidates)}`;
};
