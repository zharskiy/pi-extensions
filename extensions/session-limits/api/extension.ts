import { resolve } from "node:path";
import { createManagedExtension } from "../../../platform/extension-manager/index.ts";
import { limitsSchema } from "../../../platform/shared/index.ts";
import { conversationOnly } from "../core/conversation-host.ts";
import { DEFAULT_LIMITS, NAMESPACE, SETTINGS_FILE } from "../core/settings.ts";
import { sessionLimitsPlugin } from "./plugin.ts";

export default createManagedExtension({
  namespace: NAMESPACE,
  root: resolve(import.meta.dirname, ".."),
  host: conversationOnly,
  settings: { defaults: () => DEFAULT_LIMITS, schema: limitsSchema, file: SETTINGS_FILE },
  plugins: [sessionLimitsPlugin],
});
