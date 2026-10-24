import { resolve } from "node:path";
import { createManagedExtension } from "../../../extension-manager/index.ts";
import { mcpImportPlugin } from "./plugin.ts";

export default createManagedExtension({
  namespace: "pi-mcp-import",
  root: resolve(import.meta.dirname, ".."),
  plugins: [mcpImportPlugin],
});
