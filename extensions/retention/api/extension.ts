import { resolve } from "node:path";
import { createManagedExtension } from "../../../platform/extension-manager/index.ts";
import { globalRecord } from "../../../platform/pi-adapter/index.ts";
import { handoffRoot } from "../../../platform/shared/index.ts";
import { pidAlive } from "../core/live-markers.ts";
import { defaults, SETTINGS_FILE, schema } from "../core/settings.ts";
import { type RetentionDeps, retentionPlugin } from "./plugin.ts";

export const retentionExtension = (deps: RetentionDeps) =>
  createManagedExtension({
    namespace: "pi-retention",
    root: resolve(import.meta.dirname, ".."),
    plugins: [retentionPlugin(deps)],
    settings: { defaults: () => defaults, schema, file: SETTINGS_FILE, scope: "user" },
  });

export default retentionExtension({
  handoffRoot: handoffRoot(),
  isAlive: pidAlive,
  process: globalRecord("retention", () => ({ swept: false })),
});
