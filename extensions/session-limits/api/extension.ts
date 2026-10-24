import { resolve } from "node:path";
import { createManagedExtension } from "../../../extension-manager/index.ts";
import { conversationOnly } from "../core/conversation-host.ts";
import { DEFAULT_LIMITS, SETTINGS_FILE, schema } from "../core/settings.ts";
import { sessionLimitsPlugin } from "./plugin.ts";

export default createManagedExtension({
  namespace: "pi-session-limits",
  root: resolve(import.meta.dirname, ".."),
  host: conversationOnly,
  settings: { defaults: () => DEFAULT_LIMITS, schema, file: SETTINGS_FILE },
  plugins: [sessionLimitsPlugin],
});
