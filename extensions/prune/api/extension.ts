import { resolve } from "node:path";
import { createManagedExtension } from "../../../platform/extension-manager/index.ts";
import { globalRecord } from "../../../platform/pi-adapter/index.ts";
import { handoffRoot } from "../../../platform/shared/index.ts";
import { pidAlive } from "../core/live-markers.ts";
import { defaults, NAMESPACE, SETTINGS_FILE, schema } from "../core/settings.ts";
import { type PruneDeps, prunePlugin } from "./plugin.ts";

export const pruneExtension = (deps: PruneDeps) =>
  createManagedExtension({
    namespace: NAMESPACE,
    root: resolve(import.meta.dirname, ".."),
    plugins: [prunePlugin(deps)],
    settings: { defaults: () => defaults, schema, file: SETTINGS_FILE, scope: "user" },
  });

export default pruneExtension({
  handoffRoot: handoffRoot(),
  isAlive: pidAlive,
  process: globalRecord("prune", () => ({ swept: false })),
});
