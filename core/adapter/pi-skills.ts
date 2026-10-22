import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  CONFIG_DIR_NAME,
  DefaultPackageManager,
  loadSkills,
  type ResolvedResource,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

export type SkillFile = { name: string; description: string; path: string };

export type SkillScope = { cwd: string; agentDir: string; projectTrusted: boolean };

type SettingsStorage = Parameters<typeof SettingsManager.fromStorage>[0];

const isExclusion = (entry: unknown) =>
  typeof entry === "string" && (entry.startsWith("!") || entry.startsWith("-"));

const withoutSkillExclusions = (content: string) => {
  try {
    const settings = JSON.parse(content);

    return Array.isArray(settings?.skills)
      ? JSON.stringify({
          ...settings,
          skills: settings.skills.filter((entry: unknown) => !isExclusion(entry)),
        })
      : content;
  } catch {
    return content;
  }
};

const readOnlySettings = ({ cwd, agentDir }: SkillScope): SettingsStorage => {
  const paths = {
    global: join(agentDir, "settings.json"),
    project: join(cwd, CONFIG_DIR_NAME, "settings.json"),
  };

  return {
    withLock: (scope, read) => {
      read(existsSync(paths[scope]) ? withoutSkillExclusions(readFileSync(paths[scope], "utf8")) : undefined);
    },
  };
};

const skillFilePath = (resource: ResolvedResource) => {
  const skillFile = join(resource.path, "SKILL.md");
  const discovered = resource.metadata.source === "auto" || resource.metadata.origin === "package";

  return discovered && existsSync(skillFile) && statSync(resource.path).isDirectory()
    ? skillFile
    : resource.path;
};

export const discoverSkills = async (scope: SkillScope): Promise<SkillFile[]> => {
  const packages = new DefaultPackageManager({
    cwd: scope.cwd,
    agentDir: scope.agentDir,
    settingsManager: SettingsManager.fromStorage(readOnlySettings(scope), {
      projectTrusted: scope.projectTrusted,
    }),
  });

  const resolved = await packages.resolve(async () => "skip");

  return loadSkills({
    cwd: scope.cwd,
    agentDir: scope.agentDir,
    skillPaths: resolved.skills.filter((resource) => resource.enabled).map(skillFilePath),
    includeDefaults: false,
  }).skills.map((skill) => ({ name: skill.name, description: skill.description, path: skill.filePath }));
};

export const mergeSkills = (loaded: SkillFile[], discovered: SkillFile[]) => {
  const names = new Set(loaded.map((skill) => skill.name));

  return [...loaded, ...discovered.filter((skill) => !names.has(skill.name))];
};

export const createSkillInventory = (
  loaded: () => SkillFile[],
  discover: (scope: SkillScope) => Promise<SkillFile[]> = discoverSkills,
) => {
  let discovered: SkillFile[] | undefined;

  return {
    files: () => (discovered ? mergeSkills(loaded(), discovered) : loaded()),
    scan: async (scope: SkillScope) => {
      try {
        discovered = await discover(scope);
      } catch {
        discovered = undefined;
      }
    },
  };
};
