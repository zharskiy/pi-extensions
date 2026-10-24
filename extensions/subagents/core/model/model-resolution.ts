import type { ModelChoice, ModelResolution } from "../../../../platform/pi-adapter/index.ts";

export type UnresolvedModel = Exclude<ModelResolution, { kind: "resolved" }>;

const refs = (models: ModelChoice[]) => models.map((model) => model.ref).join(", ");

export const resolutionProblem = (resolution: UnresolvedModel) => {
  if (resolution.kind === "invalid") {
    return resolution.error;
  }

  if (resolution.kind === "ambiguous") {
    return `matches several models (${refs(resolution.candidates)}); use provider/id`;
  }

  return resolution.withoutCredentials.length > 0
    ? `matches only models without credentials (${refs(resolution.withoutCredentials)})`
    : "matches no available model";
};
