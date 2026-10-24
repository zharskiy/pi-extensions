import { resolve } from "node:path";
import { createManagedExtension } from "../../../platform/extension-manager/index.ts";
import { transcriptPlugin } from "./plugin.ts";

export default createManagedExtension({
  namespace: "pi-transcript",
  root: resolve(import.meta.dirname, ".."),
  plugins: [transcriptPlugin],
});
