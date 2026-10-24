import { resolve } from "node:path";
import { createPiExtension } from "../../../pi-adapter/index.ts";
import { createTranscript } from "./transcript.ts";

const root = resolve(import.meta.dirname, "..");

/** @public */
export default createPiExtension(
  (host) => {
    createTranscript(host);
  },
  { root, namespace: "pi-transcript" },
);
