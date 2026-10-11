import { resolve } from "node:path";
import { createPiExtension } from "../../../core/adapter/pi-adapter.ts";
import { createSpending } from "./spending.ts";

const root = resolve(import.meta.dirname, "..");

export default createPiExtension(
  (host) => {
    createSpending(host);
  },
  { root, namespace: "pi-spending" },
);
