import { resolve } from "node:path";
import { createManagedExtension } from "../../../extension-manager/index.ts";
import { footerPlugin } from "./plugin.ts";

export default createManagedExtension({
  namespace: "pi-footer",
  root: resolve(import.meta.dirname, ".."),
  plugins: [footerPlugin],
});
