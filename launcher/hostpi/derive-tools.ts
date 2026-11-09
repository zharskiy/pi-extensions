import { deriveGh, ghEnv } from "./tools/gh.ts";
import { deriveGitIdentity } from "./tools/git.ts";
import { deriveGlab, glabEnv } from "./tools/glab.ts";
import { deriveMaven } from "./tools/maven.ts";
import { deriveNpmrc } from "./tools/npmrc.ts";
import { derivePip } from "./tools/pip.ts";
import type { ToolsInput, ToolsSection } from "./types.ts";

const credentialsOf = async (input: ToolsInput) => {
  const gh = await deriveGh(input);
  const [glab, npmrc, pip, maven] = await Promise.all([
    deriveGlab(input, new Set(gh.value.map((entry) => entry.host))),
    deriveNpmrc(input),
    derivePip(input),
    deriveMaven(input),
  ]);

  return { gh, glab, npmrc, pip, maven };
};

export const deriveHostTools = async (input: ToolsInput): Promise<ToolsSection> => {
  const git = await deriveGitIdentity(input);

  if (!input.enabled) {
    return {
      value: { gh: [], glab: [], maven: { servers: [], mirrors: [] }, git, env: {} },
      rules: [],
      notices: [],
    };
  }

  const { gh, glab, npmrc, pip, maven } = await credentialsOf(input);
  const sections = [gh, glab, npmrc, pip, maven];

  return {
    value: {
      gh: gh.value,
      glab: glab.value,
      ...(npmrc.value === undefined ? {} : { npmrc: npmrc.value }),
      ...(pip.value === undefined ? {} : { pip: pip.value }),
      maven: maven.value,
      git,
      env: { ...ghEnv(gh.value), ...glabEnv(glab.value) },
    },
    rules: sections.flatMap((section) => section.rules),
    notices: sections.flatMap((section) => section.notices),
  };
};
