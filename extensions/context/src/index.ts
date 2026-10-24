import { homedir } from "node:os";
import { resolve } from "node:path";
import { createPiExtension } from "../../../pi-adapter/index.ts";
import { createContext } from "./context.ts";

const root = resolve(import.meta.dirname, "..");

export default createPiExtension(
  (host) => {
    createContext(host, { home: homedir(), now: Date.now });
  },
  { root, namespace: "pi-context" },
);
