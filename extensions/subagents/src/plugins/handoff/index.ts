import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "../../model/plugin.ts";
import { validateHandoff } from "./schema.ts";

export const handoffPlugin: Plugin = {
  id: "handoff",
  enable: ({ services, root }) => {
    const template = readFileSync(join(root, "prompts", "handoff.md"), "utf8");

    services.provide("handoff", {
      instruction: (path) => template.replaceAll("{{path}}", path).trim(),
      validate: validateHandoff,
    });

    return undefined;
  },
};
