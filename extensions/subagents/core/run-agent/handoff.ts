import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validateHandoff } from "../../../../shared/index.ts";
import type { HandoffService } from "../model/agent-record.ts";

export const createHandoff = (root: string): HandoffService => {
  const template = readFileSync(join(root, "prompts", "handoff.md"), "utf8");

  return {
    instruction: (path) => template.replaceAll("{{path}}", path).trim(),
    validate: (text) => validateHandoff(text, ["partial", "blocked"]),
  };
};
