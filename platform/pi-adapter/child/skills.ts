import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import {
  CONFIG_DIR_NAME,
  DefaultPackageManager,
  loadSkills,
  type ResolvedResource,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { SkillInfo } from "../types/messages.ts";

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

  return resource.metadata.source === "auto" && existsSync(skillFile) && statSync(resource.path).isDirectory()
    ? skillFile
    : resource.path;
};

const contains = (root: string, path: string) => {
  const inner = relative(root, path);

  return inner !== ".." && !inner.startsWith(`..${sep}`) && !isAbsolute(inner);
};

export const resourceScope = (resources: ResolvedResource[], path: string, cwd: string) => {
  const owner = resources
    .filter((resource) => contains(resource.path, path))
    .toSorted((left, right) => right.path.length - left.path.length)[0];

  return owner?.metadata.scope ?? (contains(cwd, path) ? "project" : "user");
};

export const discoverSkills = async (scope: SkillScope): Promise<SkillInfo[]> => {
  const packages = new DefaultPackageManager({
    cwd: scope.cwd,
    agentDir: scope.agentDir,
    settingsManager: SettingsManager.fromStorage(readOnlySettings(scope), {
      projectTrusted: scope.projectTrusted,
    }),
  });

  const resolved = await packages.resolve(async () => "skip");
  const enabled = resolved.skills.filter((resource) => resource.enabled);

  return loadSkills({
    cwd: scope.cwd,
    agentDir: scope.agentDir,
    skillPaths: enabled.map(skillFilePath),
    includeDefaults: false,
  }).skills.map((skill) => ({
    name: skill.name,
    description: skill.description,
    scope: resourceScope(enabled, skill.filePath, scope.cwd),
    path: skill.filePath,
  }));
};

const mergeSkills = (loaded: SkillInfo[], discovered: SkillInfo[]) => {
  const names = new Set(loaded.map((skill) => skill.name));

  return [...loaded, ...discovered.filter((skill) => !names.has(skill.name))];
};

export const createSkillInventory = (
  loaded: () => SkillInfo[],
  discover: (scope: SkillScope) => Promise<SkillInfo[]> = discoverSkills,
) => {
  let discovered: SkillInfo[] = [];

  return {
    files: () => mergeSkills(loaded(), discovered),
    scan: async (scope: SkillScope) => {
      discovered = [];
      discovered = await discover(scope);
    },
  };
};
