import { resolve } from "node:path";
import { createManagedExtension } from "../../../platform/extension-manager/index.ts";
import { conversationOnly } from "../core/conversation-host.ts";
import { DEFAULT_LIMITS, NAMESPACE, SETTINGS_FILE, schema } from "../core/settings.ts";
import { sessionLimitsPlugin } from "./plugin.ts";

export default createManagedExtension({
  namespace: NAMESPACE,
  root: resolve(import.meta.dirname, ".."),
  host: conversationOnly,
  settings: { defaults: () => DEFAULT_LIMITS, schema, file: SETTINGS_FILE },
  plugins: [sessionLimitsPlugin],
});
