import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AvailableModel, ModelResolution } from "./contract.ts";
import { type CatalogModel, resolveModel as matchCatalog } from "./model-resolver.ts";

type PiModel = NonNullable<ExtensionContext["model"]>;

const providerAuth = (ctx: ExtensionContext) => {
  const authByProvider = new Map<string, boolean>();

  return (model: PiModel) => {
    const known = authByProvider.get(model.provider);

    if (known !== undefined) {
      return known;
    }

    const configured = ctx.modelRegistry.hasConfiguredAuth(model);

    authByProvider.set(model.provider, configured);

    return configured;
  };
};

export const availableModels = (ctx: ExtensionContext): AvailableModel[] => {
  const hasAuth = providerAuth(ctx);

  return ctx.modelRegistry
    .getAll()
    .filter(hasAuth)
    .map((model) => ({
      ref: `${model.provider}/${model.id}`,
      contextWindow: model.contextWindow,
      cost: { input: model.cost.input, output: model.cost.output },
      thinking: getSupportedThinkingLevels(model),
    }))
    .sort((left, right) => left.ref.localeCompare(right.ref));
};

const catalogOf = (ctx: ExtensionContext) => {
  const models = ctx.modelRegistry.getAll();
  const hasAuth = providerAuth(ctx);

  const catalog = models.map(
    (model): CatalogModel => ({
      provider: model.provider,
      id: model.id,
      name: model.name,
      contextWindow: model.contextWindow,
      cost: { input: model.cost.input, output: model.cost.output },
      authenticated: hasAuth(model),
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
