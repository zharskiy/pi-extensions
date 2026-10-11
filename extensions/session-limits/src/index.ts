import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createPiExtension } from "../../../core/adapter/pi-adapter.ts";
import { conversationOnly } from "./conversation.ts";
import { createLimits } from "./limits.ts";
import { watchSettings } from "./settings.ts";

const root = resolve(import.meta.dirname, "..");

export default createPiExtension(
  (piHost, _runtime, paths) => {
    const host = conversationOnly(piHost);
    const ratios = watchSettings(host);
    const template = readFileSync(join(paths.root, "prompts", "handoff.md"), "utf8");

    createLimits({ host, template, ratios });
  },
  { root, namespace: "pi-session-limits" },
);
