import { resolve } from "node:path";
import { createManagedExtension } from "../../../platform/extension-manager/index.ts";
import { questionnairePlugin } from "./plugin.ts";

export default createManagedExtension({
  namespace: "pi-questionnaire",
  root: resolve(import.meta.dirname, ".."),
  plugins: [questionnairePlugin],
});
