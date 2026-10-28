import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const UNICODE_SPACES = /[  -   　]/g;

const SKILL_FILE = "SKILL.md";

const pathArg = (args: unknown) => {
  if (typeof args !== "object" || args === null) {
    return undefined;
  }

  const { path, file_path: filePath } = args as { path?: unknown; file_path?: unknown };

  return [path, filePath].find((value): value is string => typeof value === "string" && value !== "");
};

const expanded = (raw: string, home: string) => {
  const unprefixed = raw.startsWith("@") ? raw.slice(1) : raw;
  const spaced = unprefixed.replace(UNICODE_SPACES, " ");

  if (spaced.startsWith("file://")) {
    return fileURLToPath(spaced);
  }

  if (spaced === "~") {
    return home;
  }

  return spaced.startsWith("~/") ? `${home}${spaced.slice(1)}` : spaced;
};

export const skillOfRead = (
  name: string,
  args: unknown,
  cwd: string,
  home: string,
): { name: string } | undefined => {
  const raw = name === "read" ? pathArg(args) : undefined;

  if (raw === undefined) {
    return undefined;
  }

  try {
    const resolved = resolve(cwd, expanded(raw, home));

    return basename(resolved) === SKILL_FILE ? { name: basename(dirname(resolved)) } : undefined;
  } catch {
    return undefined;
  }
};
