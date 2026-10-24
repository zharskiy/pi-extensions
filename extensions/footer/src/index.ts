import { resolve } from "node:path";
import { createPiExtension } from "../../../pi-adapter/index.ts";
import { createFooter } from "./footer.ts";

const root = resolve(import.meta.dirname, "..");

/** @public */
export default createPiExtension(
  (host) => {
    createFooter(host);
  },
  { root, namespace: "pi-footer" },
);
