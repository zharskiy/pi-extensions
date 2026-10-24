import { resolve } from "node:path";
import { createManagedExtension } from "../../../extension-manager/index.ts";
import { spendingPlugin } from "./plugin.ts";

export default createManagedExtension({
  namespace: "pi-spending",
  root: resolve(import.meta.dirname, ".."),
  plugins: [spendingPlugin],
});
