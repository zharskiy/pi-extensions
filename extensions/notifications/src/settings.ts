import type { NotifyChannel } from "../../../pi-adapter/index.ts";
import type { SettingsSchema } from "../../../shared/index.ts";

export type NotificationSettings = {
  channel: NotifyChannel | "off";
  idleDelayMs: number;
  dialogDelayMs: number;
};

export const SETTINGS_FILE = "pi-notifications.json";

export const defaults: NotificationSettings = {
  channel: "auto",
  idleDelayMs: 20_000,
  dialogDelayMs: 6_000,
};

const delay = { type: "number", min: 0, max: 600_000 } as const;

export const schema: SettingsSchema<NotificationSettings> = {
  channel: { type: "choice", values: ["auto", "bell", "off"] },
  idleDelayMs: delay,
  dialogDelayMs: delay,
};
