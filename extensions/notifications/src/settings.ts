import type { Host } from "../../../core/adapter/contract.ts";
import {
  projectSettingsPath,
  readSettingsFile,
  type SettingsSchema,
  userSettingsPath,
} from "../../../core/manager/settings.ts";

export type Channel = "auto" | "bell" | "off";

export type NotificationSettings = { channel: Channel; idleDelayMs: number; dialogDelayMs: number };

export const SETTINGS_FILE = "pi-notifications.json";

export const DEFAULT_SETTINGS: NotificationSettings = {
  channel: "auto",
  idleDelayMs: 20_000,
  dialogDelayMs: 6_000,
};

const delay = { type: "number", min: 0, max: 600_000 } as const;

const schema: SettingsSchema<NotificationSettings> = {
  channel: { type: "choice", values: ["auto", "bell", "off"] },
  idleDelayMs: delay,
  dialogDelayMs: delay,
};

export const loadSettings = (agentDir: string, cwd: string, projectTrusted: boolean) => {
  const user = readSettingsFile(schema, userSettingsPath(agentDir, SETTINGS_FILE));

  const project = projectTrusted
    ? readSettingsFile(schema, projectSettingsPath(cwd, SETTINGS_FILE))
    : { patch: {}, errors: [] };

  return {
    settings: { ...DEFAULT_SETTINGS, ...user.patch, ...project.patch },
    errors: [...user.errors, ...project.errors],
  };
};

export const watchSettings = (host: Host): (() => NotificationSettings) => {
  let settings = DEFAULT_SETTINGS;
  const reported = new Set<string>();

  host.onSessionStart((info) => {
    const loaded = loadSettings(info.agentDir, info.cwd, info.projectTrusted);

    settings = loaded.settings;

    loaded.errors
      .filter((error) => !reported.has(error))
      .forEach((error) => {
        reported.add(error);
        host.ui.notify(`pi-notifications settings: ${error}`, "warning");
      });
  });

  return () => settings;
};
