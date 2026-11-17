import { resolve } from "node:path";
import { createManagedExtension } from "../../../platform/extension-manager/index.ts";
import { modelDefaultPlugin, NAMESPACE } from "./plugin.ts";

export default createManagedExtension({
  namespace: NAMESPACE,
  root: resolve(import.meta.dirname, ".."),
  plugins: [modelDefaultPlugin],
});
