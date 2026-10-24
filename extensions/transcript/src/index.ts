import { resolve } from "node:path";
import { createPiExtension } from "../../../core/adapter/pi-adapter.ts";
import { createTranscript } from "./transcript.ts";

const root = resolve(import.meta.dirname, "..");

/** @public */
export default createPiExtension(
  (host) => {
    createTranscript(host);
  },
  { root, namespace: "pi-transcript" },
);
