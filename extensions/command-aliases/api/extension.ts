import { resolve } from "node:path";
import { createManagedExtension } from "../../../platform/extension-manager/index.ts";
import { commandAliasesPlugin } from "./plugin.ts";

export default createManagedExtension({
  namespace: "pi-command-aliases",
  root: resolve(import.meta.dirname, ".."),
  plugins: [commandAliasesPlugin],
});
