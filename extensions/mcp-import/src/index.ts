import { homedir } from "node:os";
import { resolve } from "node:path";
import { createPiExtension } from "../../../pi-adapter/index.ts";
import { createMcpImport } from "./mcp-import.ts";

const root = resolve(import.meta.dirname, "..");

/** @public */
export default createPiExtension(
  (host) => {
    createMcpImport(host, homedir());
  },
  { root, namespace: "pi-mcp-import" },
);
