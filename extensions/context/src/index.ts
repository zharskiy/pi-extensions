import { homedir } from "node:os";
import { resolve } from "node:path";
import { createPiExtension } from "../../../core/adapter/pi-adapter.ts";
import { createContext } from "./context.ts";

const root = resolve(import.meta.dirname, "..");

/** @public */
export default createPiExtension(
  (host) => {
    createContext(host, { home: homedir(), now: Date.now });
  },
  { root, namespace: "pi-context" },
);
