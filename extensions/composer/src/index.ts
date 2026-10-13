import { resolve } from "node:path";
import { createPiExtension } from "../../../core/adapter/pi-adapter.ts";
import { createComposer } from "./composer.ts";

const root = resolve(import.meta.dirname, "..");

export default createPiExtension(
  (host) => {
    createComposer(host);
  },
  { root, namespace: "pi-composer" },
);
