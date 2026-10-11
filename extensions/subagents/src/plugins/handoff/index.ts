import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "../../manager/plugin.ts";
import { validateHandoff } from "./schema.ts";

export const handoffPlugin: Plugin = {
  id: "handoff",
  enable: ({ services, packageRoot }) => {
    const template = readFileSync(join(packageRoot, "prompts", "handoff.md"), "utf8");

    services.provide("handoff", {
      instruction: (path) => template.replaceAll("{{path}}", path).trim(),
      validate: validateHandoff,
    });

    return undefined;
  },
};
