import type { Host } from "../pi-adapter/index.ts";

export type SettingsReport = (errors: readonly string[], level?: "warning" | "info") => void;

const reporters = new WeakMap<Host, Map<string, SettingsReport>>();

const createReport = (host: Host, label: string): SettingsReport => {
  const reported = new Set<string>();

  return (errors, level = "warning") =>
    errors
      .filter((error) => !reported.has(error))
      .forEach((error) => {
        reported.add(error);
        host.ui.notify(`${label} settings: ${error}`, level);
      });
};

export const reportSettingsErrors = (host: Host, label: string) => {
  const byLabel = reporters.get(host) ?? new Map<string, SettingsReport>();
  const report = byLabel.get(label) ?? createReport(host, label);

  byLabel.set(label, report);
  reporters.set(host, byLabel);

  return report;
};
