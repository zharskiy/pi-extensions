import { resolve } from "node:path";
import { createPiExtension } from "../../../pi-adapter/index.ts";
import { createQuestionnaire } from "./questionnaire.ts";

const root = resolve(import.meta.dirname, "..");

/** @public */
export default createPiExtension(
  (host) => {
    createQuestionnaire(host);
  },
  { root, namespace: "pi-questionnaire" },
);
