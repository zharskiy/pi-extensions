import { resolve } from "node:path";
import { createManagedExtension } from "../../../extension-manager/index.ts";
import { composerPlugin } from "./plugin.ts";

export default createManagedExtension({
  namespace: "pi-composer",
  root: resolve(import.meta.dirname, ".."),
  plugins: [composerPlugin],
});
