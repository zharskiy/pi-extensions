import type { Host } from "../pi-adapter/index.ts";

export const reportSettingsErrors = (host: Host, label: string) => {
  const reported = new Set<string>();

  return (errors: readonly string[]) =>
    errors
      .filter((error) => !reported.has(error))
      .forEach((error) => {
        reported.add(error);
        host.ui.notify(`${label} settings: ${error}`, "warning");
      });
};
