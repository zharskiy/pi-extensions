import { resolve } from "node:path";
import { createManagedExtension } from "../../../extension-manager/index.ts";
import { stylePlugin } from "./plugin.ts";

export default createManagedExtension({
  namespace: "pi-style",
  root: resolve(import.meta.dirname, ".."),
  plugins: [stylePlugin],
});
