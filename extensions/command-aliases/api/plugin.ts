import type { Host } from "../../../pi-adapter/index.ts";
import type { Plugin } from "../../../shared/index.ts";
import { ALIASES, targetOf } from "../core/aliases.ts";

export const createCommandAliases = (host: Host) => {
  host.onSessionStart(() => {
    host.ui.onEditorSubmit(targetOf);
    host.ui.mapCommandCompletion(targetOf);
  });

  ALIASES.forEach((target, alias) => {
    host.registerCommand(alias.slice(1), {
      description: `Alias for ${target}`,
      run: async () => {
        if (await host.ui.submitEditor(target)) {
          return;
        }

        host.ui.notify(`Could not run ${target}`, "error");
      },
    });
  });
};

export const commandAliasesPlugin: Plugin<never, never, undefined> = {
  id: "command-aliases",
  enable({ host }) {
    createCommandAliases(host);

    return undefined;
  },
};
