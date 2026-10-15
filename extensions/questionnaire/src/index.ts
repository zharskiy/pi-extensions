import { resolve } from "node:path";
import { createPiExtension } from "../../../core/adapter/pi-adapter.ts";
import { createQuestionnaire } from "./questionnaire.ts";

const root = resolve(import.meta.dirname, "..");

export default createPiExtension(
  (host) => {
    createQuestionnaire(host);
  },
  { root, namespace: "pi-questionnaire" },
);
