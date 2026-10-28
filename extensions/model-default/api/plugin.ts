import type { Host } from "../../../platform/pi-adapter/index.ts";
import type { Plugin } from "../../../platform/shared/index.ts";

export const createModelDefault = (host: Host) => {
  host.onModelSelect(async (ref) => {
    const failure = await host.saveDefaultModel(ref);

    if (failure) {
      host.ui.notify(`pi-model-default: ${ref} is not saved as the default model: ${failure}`, "warning");
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
