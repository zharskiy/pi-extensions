import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { type CliDeps, pathsOf } from "./deps.ts";

const kindOf = (path: string) =>
  stat(path).then(
    (info) => (info.isDirectory() ? "directory" : "file"),
    () => undefined,
  );

const isOther = (path: string, current: string) => resolve(path) !== resolve(current);

interface LegacyPath {
  problem: string;
  fix: string;
}

const noticeOf = (legacy: LegacyPath) => `${legacy.problem}; ${legacy.fix}`;

export const movedConfig = async (deps: CliDeps): Promise<LegacyPath[]> => {
  const legacy = join(deps.home, ".config", "pi-sandbox", "config.json");

  if ((await kindOf(legacy)) !== "file") {
    return [];
  }

  const current = pathsOf(deps).userConfigFile;

  return (await kindOf(current)) === undefined
    ? [{ problem: `${legacy} is no longer read`, fix: `move it to ${current}` }]
    : [];
};

const LEGACY_POLICY_FILES = {
  darwin: "/Library/Application Support/pi-sandbox/policy.json",
  other: "/etc/pi-sandbox/policy.json",
};

export const ignoredPolicy = async (deps: CliDeps): Promise<LegacyPath[]> => {
  const standard = deps.platform === "darwin" ? LEGACY_POLICY_FILES.darwin : LEGACY_POLICY_FILES.other;
  const configured = deps.env.PI_SANDBOX_POLICY_FILE ?? "";
  const present = (await kindOf(standard)) === "file" ? [standard] : [];
  const files = [...new Set(configured === "" ? present : [...present, configured])];

  return files.map((file) => ({
    problem: `${file} is no longer read, so its limits do not apply`,
    fix: `move what you need into ${pathsOf(deps).userConfigFile}`,
  }));
};

export const legacyNotices = async (deps: CliDeps) =>
  [...(await movedConfig(deps)), ...(await ignoredPolicy(deps))].map(noticeOf);

export const leftoverState = async (deps: CliDeps): Promise<LegacyPath[]> => {
  const legacy = join(deps.home, ".local", "state", "pi-sandbox");
  const current = pathsOf(deps).stateDir;

  if (!isOther(legacy, current) || (await kindOf(legacy)) !== "directory") {
    return [];
  }

  return [
    {
      problem: `${legacy} is no longer used, the launcher keeps its state in ${current}`,
      fix: "delete it once no pi session started before the move runs",
    },
  ];
};
