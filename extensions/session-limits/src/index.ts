import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createPiExtension } from "../../../core/adapter/pi-adapter.ts";
import { watchSettings } from "../../../core/manager/settings.ts";
import { conversationOnly } from "./conversation.ts";
import { createLimits } from "./limits.ts";
import { DEFAULT_LIMITS, SETTINGS_FILE, schema } from "./settings.ts";

const root = resolve(import.meta.dirname, "..");

/** @public */
export default createPiExtension(
  (piHost, _runtime, paths) => {
    const host = conversationOnly(piHost);
    const limits = watchSettings(host, "pi-session-limits", schema, DEFAULT_LIMITS, SETTINGS_FILE);
    const template = readFileSync(join(paths.root, "prompts", "handoff.md"), "utf8");

    createLimits({ host, template, limits });
  },
  { root, namespace: "pi-session-limits" },
);
