import { resolve } from "node:path";
import { createPiExtension } from "../../../pi-adapter/index.ts";
import { createSpending } from "./spending.ts";

const root = resolve(import.meta.dirname, "..");

/** @public */
export default createPiExtension(
  (host) => {
    createSpending(host);
  },
  { root, namespace: "pi-spending" },
);
