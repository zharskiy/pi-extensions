import { join, resolve } from "node:path";
import { createPiExtension } from "../../../core/adapter/pi-adapter.ts";
import { createStyle } from "./style.ts";
import { loadStyles } from "./styles.ts";

const root = resolve(import.meta.dirname, "..");

export default createPiExtension(
  (host, _runtime, paths) => {
    createStyle(host, loadStyles(join(paths.root, "prompts")));
  },
  { root, namespace: "pi-style" },
);
