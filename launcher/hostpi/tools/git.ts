import type { GitIdentity, ToolsInput } from "../types.ts";

const IDENTITY_LINE = /^user\.(name|email) (.+)$/;

export const deriveGitIdentity = async (input: ToolsInput): Promise<GitIdentity> => {
  const result = await input.runner
    .run("git", ["config", "--global", "--includes", "--get-regexp", "^user\\.(name|email)$"])
    .catch(() => undefined);

  if (result === undefined || result.code !== 0) {
    return {};
  }

  return Object.fromEntries(
    result.stdout.split(/\r?\n/).flatMap((line) => {
      const match = IDENTITY_LINE.exec(line.trim());

      return match === null ? [] : [[match[1] ?? "", match[2] ?? ""]];
    }),
  );
};
