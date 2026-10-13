import type { Host } from "../../../core/adapter/contract.ts";

export const ALIASES: Record<string, string> = {
  "/continue": "/resume",
  "/clear": "/new",
  "/exit": "/quit",
};

const targets = new Map(Object.entries(ALIASES));

const targetOf = (text: string) => targets.get(text.trim());

export const createCommandAliases = (host: Host) => {
  host.onSessionStart(() => {
    host.ui.onEditorSubmit(targetOf);
    host.ui.mapCommandCompletion(targetOf);
  });

  targets.forEach((target, alias) => {
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
