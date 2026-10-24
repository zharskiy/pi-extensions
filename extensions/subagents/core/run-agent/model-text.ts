import type { ModelChoice } from "../../../../pi-adapter/index.ts";
import { formatTokens } from "../../../../shared/index.ts";
import { resolutionProblem, type UnresolvedModel } from "../model/model-resolution.ts";

const choiceLine = (choice: ModelChoice) =>
  `- ${choice.ref} (context ${formatTokens(choice.contextWindow)}, $${choice.cost.input}/$${choice.cost.output} per Mtok in/out)`;

const choiceList = (choices: ModelChoice[]) => choices.map(choiceLine).join("\n");

const unknownAdvice = (resolution: Extract<UnresolvedModel, { kind: "unknown" }>) => {
  if (resolution.withoutCredentials.length > 0) {
    return ` Tell the user; they can log in with /login, or the agent can run on its own model:\n${choiceList(resolution.withoutCredentials)}`;
  }

  return resolution.candidates.length === 0
    ? " Ask the user for the model name."
    : ` Did you mean one of these? Ask the user:\n${choiceList(resolution.candidates)}`;
};

export const resolutionError = (agent: string, resolution: UnresolvedModel) => {
  const head = `${agent}: model "${resolution.request}": ${resolutionProblem(resolution)}.`;

  if (resolution.kind === "ambiguous") {
    return `${head} Ask the user which one to use, then call run_agent again with that provider/id:\n${choiceList(resolution.candidates)}`;
  }

  return resolution.kind === "unknown" ? `${head}${unknownAdvice(resolution)}` : head;
};
