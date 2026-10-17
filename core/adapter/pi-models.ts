import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type AvailableModel, type ModelResolution, THINKING_LEVELS } from "./contract.ts";
import { type CatalogModel, resolveModel as matchCatalog } from "./model-resolver.ts";

type PiModel = NonNullable<ExtensionContext["model"]>;

type ThinkingFacts = Pick<PiModel, "reasoning" | "thinkingLevelMap">;

const ON_REQUEST_ONLY = ["xhigh", "max"];

export const thinkingLevelsOf = (model: ThinkingFacts) => {
  if (!model.reasoning) {
    return ["off"];
  }

  const map: Record<string, string | null | undefined> = model.thinkingLevelMap ?? {};

  return THINKING_LEVELS.filter((level) => {
    const mapped = map[level];

    return mapped !== null && (!ON_REQUEST_ONLY.includes(level) || mapped !== undefined);
  });
};

export const availableModels = (ctx: ExtensionContext): AvailableModel[] =>
  ctx.modelRegistry
    .getAll()
    .filter((model) => ctx.modelRegistry.hasConfiguredAuth(model))
    .map((model) => ({
      ref: `${model.provider}/${model.id}`,
      contextWindow: model.contextWindow,
      cost: { input: model.cost.input, output: model.cost.output },
      thinking: thinkingLevelsOf(model),
    }))
    .sort((left, right) => left.ref.localeCompare(right.ref));

const catalogOf = (ctx: ExtensionContext) => {
  const models = ctx.modelRegistry.getAll();

  const catalog = models.map(
    (model): CatalogModel => ({
      provider: model.provider,
      id: model.id,
      name: model.name,
      contextWindow: model.contextWindow,
      cost: { input: model.cost.input, output: model.cost.output },
      authenticated: ctx.modelRegistry.hasConfiguredAuth(model),
    }),
  );

  return { models, catalog };
};

export const resolveFromCatalog = (
  ctx: ExtensionContext,
  request: string | undefined,
  defaultProvider: string | undefined,
): { resolution: ModelResolution; model?: PiModel } => {
  if (!request) {
    if (!ctx.model) {
      return {
        resolution: { kind: "invalid", request: "inherit", error: "the main session has no model selected" },
      };
    }

    const ref = `${ctx.model.provider}/${ctx.model.id}`;

    return {
      resolution: {
        kind: "resolved",
        request: "inherit",
        model: {
          ref,
          contextWindow: ctx.model.contextWindow,
          cost: { input: ctx.model.cost.input, output: ctx.model.cost.output },
        },
      },
      model: ctx.model,
    };
  }

  const { models, catalog } = catalogOf(ctx);
  const resolution = matchCatalog(request, catalog, {
    sessionProvider: ctx.model?.provider,
    defaultProvider,
  });

  if (resolution.kind !== "resolved") {
    return { resolution };
  }

  const model = models.find((candidate) => `${candidate.provider}/${candidate.id}` === resolution.model.ref);

  return { resolution, model };
};

export const resolutionFailure = (resolution: ModelResolution) => {
  if (resolution.kind === "invalid") {
    return resolution.error;
  }

  return `model "${resolution.request}" is ${resolution.kind}; use an exact provider/id`;
};
