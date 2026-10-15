import { resolve } from "node:path";
import { createPiExtension } from "../../../core/adapter/pi-adapter.ts";
import { watchSettings } from "../../../core/manager/settings.ts";
import { createNotifications } from "./notifications.ts";
import { defaults, SETTINGS_FILE, schema } from "./settings.ts";

const root = resolve(import.meta.dirname, "..");

export default createPiExtension(
  (host) => {
    createNotifications(host, watchSettings(host, "pi-notifications", schema, defaults, SETTINGS_FILE));
  },
  { root, namespace: "pi-notifications" },
);
