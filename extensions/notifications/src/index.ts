import { resolve } from "node:path";
import { watchSettings } from "../../../core/manager/settings.ts";
import { createPiExtension } from "../../../pi-adapter/index.ts";
import { createNotifications } from "./notifications.ts";
import { defaults, SETTINGS_FILE, schema } from "./settings.ts";

const root = resolve(import.meta.dirname, "..");

/** @public */
export default createPiExtension(
  (host) => {
    createNotifications(host, watchSettings(host, "pi-notifications", schema, defaults, SETTINGS_FILE));
  },
  { root, namespace: "pi-notifications" },
);
