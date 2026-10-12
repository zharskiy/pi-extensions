import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type ViewMode = "focus" | "verbose";

export type ModeStore = { read(): ViewMode; write(mode: ViewMode): boolean };

export const VIEW_STATE_FILE = "pi-subagents-view.json";

export const viewStatePath = (agentDir: string) => join(agentDir, VIEW_STATE_FILE);

const parseMode = (text: string): ViewMode => {
  const parsed = JSON.parse(text) as { mode?: unknown } | null;

  return parsed?.mode === "verbose" ? "verbose" : "focus";
};

export const createModeStore = (path: string): ModeStore => ({
  read: () => {
    try {
      return parseMode(readFileSync(path, "utf8"));
    } catch {
      return "focus";
    }
  },
  write: (mode) => {
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify({ mode }, null, 2)}\n`);

      return true;
    } catch {
      return false;
    }
  },
});
