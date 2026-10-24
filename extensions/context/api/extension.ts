import { resolve } from "node:path";
import { createManagedExtension } from "../../../extension-manager/index.ts";
import { contextPlugin } from "./plugin.ts";

export default createManagedExtension({
  namespace: "pi-context",
  root: resolve(import.meta.dirname, ".."),
  plugins: [contextPlugin],
});
