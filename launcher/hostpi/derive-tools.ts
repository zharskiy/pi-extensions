import { deriveGh, ghEnv } from "./tools/gh.ts";
import { deriveGitIdentity } from "./tools/git.ts";
import { deriveGlab, glabEnv } from "./tools/glab.ts";
import { deriveMaven } from "./tools/maven.ts";
import { deriveNpmrc } from "./tools/npmrc.ts";
import { derivePip } from "./tools/pip.ts";
import { emptyToolsSection, type ToolsInput, type ToolsSection } from "./types.ts";

const credentialsOf = async (input: ToolsInput) => {
  const [git, gh, glab, npmrc, pip, maven] = await Promise.all([
    deriveGitIdentity(input),
    deriveGh(input),
    deriveGlab(input),
    deriveNpmrc(input),
    derivePip(input),
    deriveMaven(input),
  ]);
  return { git, gh, glab, npmrc, pip, maven };
};

export const deriveHostTools = async (input: ToolsInput): Promise<ToolsSection> => {
  if (!input.enabled) {
    const git = await deriveGitIdentity(input);

    return emptyToolsSection(git.value, git.notices);
  }

  const { git, gh, glab, npmrc, pip, maven } = await credentialsOf(input);
  const sections = [git, gh, glab, npmrc, pip, maven];

  return {
    value: {
      gh: gh.value,
      glab: glab.value,
      ...(npmrc.value === undefined ? {} : { npmrc: npmrc.value }),
      ...(pip.value === undefined ? {} : { pip: pip.value }),
      maven: maven.value,
      git: git.value,
      env: { ...ghEnv(gh.value), ...glabEnv(glab.value) },
    },
    rules: sections.flatMap((section) => section.rules),
    notices: sections.flatMap((section) => section.notices),
    registries: [...npmrc.registries, ...pip.registries, ...maven.registries],
  };
};
