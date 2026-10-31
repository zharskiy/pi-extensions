import { resolve } from "node:path";
import { createManagedExtension } from "../../../platform/extension-manager/index.ts";
import { modelDefaultPlugin } from "./plugin.ts";

export default createManagedExtension({
  namespace: "pi-model-default",
  root: resolve(import.meta.dirname, ".."),
  plugins: [modelDefaultPlugin],
});
