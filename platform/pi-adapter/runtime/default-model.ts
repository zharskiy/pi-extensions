import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "../types/model.ts";

const refOf = (model: { provider: string; id: string }) => `${model.provider}/${model.id}`;

const widenScope = (settings: SettingsManager, ctx: ExtensionContext, ref: string) => {
  const scoped = ctx.scopedModels.map(({ model }) => refOf(model));

  if (scoped.length === 0 || scoped.includes(ref)) {
    return;
  }

  const enabled = settings.getEnabledModels() ?? [];
  const listed = enabled.some((pattern) => pattern.toLowerCase() === ref.toLowerCase());

  if (enabled.length === 0 || listed) {
    return;
  }

  settings.setEnabledModels([...enabled, ref]);
};

const globalErrors = (settings: SettingsManager) =>
  settings
    .drainErrors()
    .filter(({ scope }) => scope === "global")
    .map(({ error }) => error.message);

const writeGlobalSettings = async (
  ctx: ExtensionContext,
  change: (settings: SettingsManager) => void,
): Promise<string | undefined> => {
  try {
    const settings = SettingsManager.create(ctx.cwd, getAgentDir(), {
      projectTrusted: ctx.isProjectTrusted(),
    });

    change(settings);

    await settings.flush();

    const errors = globalErrors(settings);

    return errors.length > 0 ? errors.join("; ") : undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

export const writeDefaultModel = (ctx: ExtensionContext, ref: string) =>
  writeGlobalSettings(ctx, (settings) => {
    const slash = ref.indexOf("/");

    settings.setDefaultModelAndProvider(ref.slice(0, slash), ref.slice(slash + 1));
    widenScope(settings, ctx, ref);
  });

export const writeDefaultThinkingLevel = (ctx: ExtensionContext, level: ThinkingLevel) =>
  writeGlobalSettings(ctx, (settings) => {
    settings.setDefaultThinkingLevel(level);
  });
