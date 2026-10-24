import { resolve } from "node:path";
import { createManagedExtension } from "../../../platform/extension-manager/index.ts";
import { defaults, SETTINGS_FILE, schema } from "../core/settings.ts";
import { notificationsPlugin } from "./plugin.ts";

export default createManagedExtension({
  namespace: "pi-notifications",
  root: resolve(import.meta.dirname, ".."),
  plugins: [notificationsPlugin],
  settings: { defaults: () => defaults, schema, file: SETTINGS_FILE },
});
