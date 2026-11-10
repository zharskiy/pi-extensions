import { findOnPath } from "../path-search.ts";
import { noticeOnly, type Section } from "../rules.ts";
import type { GitIdentity, ToolsInput } from "../types.ts";
import { PROBE_TIMEOUT_MS, timedOutNotice } from "./files.ts";

const IDENTITY_LINE = /^user\.(name|email) (.+)$/;

const identityOf = (stdout: string): GitIdentity =>
  Object.fromEntries(
    stdout.split(/\r?\n/).flatMap((line) => {
      const match = IDENTITY_LINE.exec(line.trim());

      return match === null ? [] : [[match[1] ?? "", match[2] ?? ""]];
    }),
  );

export const deriveGitIdentity = async (input: ToolsInput): Promise<Section<GitIdentity>> => {
  const git = await findOnPath(input.env, "git", input.excludedRoots);

  if (git === undefined) {
    return noticeOnly({});
  }

  const result = await input.runner
    .run(git, ["config", "--global", "--includes", "--get-regexp", "^user\\.(name|email)$"], {
      timeoutMs: PROBE_TIMEOUT_MS,
    })
    .catch(() => undefined);

  if (result?.timedOut === true) {
    return noticeOnly({}, timedOutNotice("git", `${git} config --global`));
  }

  return result === undefined || result.code !== 0 ? noticeOnly({}) : noticeOnly(identityOf(result.stdout));
};
