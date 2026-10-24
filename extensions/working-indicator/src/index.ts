import { resolve } from "node:path";
import { createPiExtension } from "../../../core/adapter/pi-adapter.ts";
import { createWorkingIndicator } from "./working-indicator.ts";

const root = resolve(import.meta.dirname, "..");

/** @public */
export default createPiExtension(
  (host) => {
    createWorkingIndicator(host);
  },
  { root, namespace: "pi-working-indicator" },
);
