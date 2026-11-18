import { resolve } from "node:path";
import { createManagedExtension } from "../../../platform/extension-manager/index.ts";
import { NAMESPACE } from "../core/questionnaire.ts";
import { questionnairePlugin } from "./plugin.ts";

export default createManagedExtension({
  namespace: NAMESPACE,
  root: resolve(import.meta.dirname, ".."),
  plugins: [questionnairePlugin],
});
