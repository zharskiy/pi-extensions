import { resolve } from "node:path";
import { createManagedExtension } from "../../../platform/extension-manager/index.ts";
import { workingIndicatorPlugin } from "./plugin.ts";

export default createManagedExtension({
  namespace: "pi-working-indicator",
  root: resolve(import.meta.dirname, ".."),
  plugins: [workingIndicatorPlugin],
});
