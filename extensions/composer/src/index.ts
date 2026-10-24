import { resolve } from "node:path";
import { createPiExtension } from "../../../pi-adapter/index.ts";
import { createComposer } from "./composer.ts";

const root = resolve(import.meta.dirname, "..");

/** @public */
export default createPiExtension(
  (host) => {
    createComposer(host);
  },
  { root, namespace: "pi-composer" },
);
