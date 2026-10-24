import { resolve } from "node:path";
import { createPiExtension } from "../../../core/adapter/pi-adapter.ts";
import { createCommandAliases } from "./command-aliases.ts";

const root = resolve(import.meta.dirname, "..");

/** @public */
export default createPiExtension(
  (host) => {
    createCommandAliases(host);
  },
  { root, namespace: "pi-command-aliases" },
);
