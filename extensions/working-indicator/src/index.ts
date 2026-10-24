import { resolve } from "node:path";
import { createPiExtension } from "../../../pi-adapter/index.ts";
import { createWorkingIndicator } from "./working-indicator.ts";

const root = resolve(import.meta.dirname, "..");

/** @public */
export default createPiExtension(
  (host) => {
    createWorkingIndicator(host);
  },
  { root, namespace: "pi-working-indicator" },
);
