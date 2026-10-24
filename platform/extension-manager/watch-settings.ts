import type { Host } from "../pi-adapter/index.ts";
import { loadSettingsFiles, type SettingsSchema } from "../shared/index.ts";

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

export const watchSettings = <T>(
  host: Host,
  label: string,
  schema: SettingsSchema<T>,
  defaults: T,
  file: string,
): (() => T) => {
  const report = reportSettingsErrors(host, label);
  let settings = defaults;

  host.onSessionStart((info) => {
    const loaded = loadSettingsFiles(schema, defaults, file, info);

    settings = loaded.settings;
    report(loaded.errors);
  });

  return () => settings;
};
