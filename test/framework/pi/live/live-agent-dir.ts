import { copyFileSync, existsSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

const LINKED_FILES = ["auth.json"];

const COPIED_FILES = ["models.json"];

const CONTEXT_FILES = ["AGENTS.override.md", "AGENTS.md", "CLAUDE.md", "SYSTEM.md", "APPEND_SYSTEM.md"];

type Isolation = { realAgentDir: string; previous: string | undefined };

let isolation: Isolation | undefined;

export const prepareAgentDir = (realAgentDir: string, agentDir: string) => {
  const present = (names: string[]) => names.filter((name) => existsSync(join(realAgentDir, name)));

  present(LINKED_FILES).forEach((name) => {
    symlinkSync(join(realAgentDir, name), join(agentDir, name));
  });

  present(COPIED_FILES).forEach((name) => {
    copyFileSync(join(realAgentDir, name), join(agentDir, name));
  });
};

export const isolateAgentDir = (realAgentDir: string, agentDir: string) => {
  const previous = process.env[AGENT_DIR_ENV];

  prepareAgentDir(realAgentDir, agentDir);
  process.env[AGENT_DIR_ENV] = agentDir;
  isolation = { realAgentDir, previous };
};

export const restoreAgentDir = () => {
  if (!isolation) {
    return;
  }

  if (isolation.previous === undefined) {
    delete process.env[AGENT_DIR_ENV];
  } else {
    process.env[AGENT_DIR_ENV] = isolation.previous;
  }

  isolation = undefined;
};

const isolated = () => {
  if (!isolation) {
    throw new Error("setupLive() has not run");
  }

  return isolation;
};

export const realContextMarkers = () =>
  CONTEXT_FILES.map((name) => join(isolated().realAgentDir, name))
    .filter((path) => existsSync(path))
    .flatMap((path) =>
      readFileSync(path, "utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .slice(0, 1),
    );
