import type { Host } from "../../../platform/pi-adapter/index.ts";
import type { Plugin } from "../../../platform/shared/index.ts";

export const createModelDefault = (host: Host) => {
  let chosen: string | undefined;
  let landed: string | undefined;
  let reapplying = false;

  host.onModelSelect(async (ref) => {
    if (chosen) {
      reapplying = true;
      host.setThinkingLevel(chosen);
      reapplying = false;
    }

    const level = host.thinkingLevel();

    landed = level === chosen ? undefined : level;

    const failure = await host.saveDefaultModel(ref);

    if (failure) {
      host.ui.notify(`pi-model-default: ${ref} is not saved as the default model: ${failure}`, "warning");
    }
  });

  host.onThinkingSelect(async (level) => {
    if (reapplying || level === landed) {
      return;
    }

    chosen = level;
    landed = undefined;

    const failure = await host.saveDefaultThinkingLevel(level);

    if (failure) {
      host.ui.notify(
        `pi-model-default: ${level} is not saved as the default thinking level: ${failure}`,
        "warning",
      );
    }
  });
};

export const modelDefaultPlugin: Plugin<never, never, undefined> = {
  id: "model-default",
  enable({ host }) {
    createModelDefault(host);

    return undefined;
  },
};
