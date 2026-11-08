import { readFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { Backend } from "../backend/index.ts";
import { type CheckResult, failed, passed, skipped } from "../container/index.ts";
import { liveSessions } from "../grants/index.ts";
import { expandHome, isWithin, LauncherError, realOrResolvedSync } from "../shared/index.ts";
import { mountedGitDirs } from "../workspace/index.ts";
import { type CliDeps, withFallbackHint, writeLine } from "./deps.ts";
import { hostSessionsOf } from "./host-sessions.ts";
import type { LaunchContext } from "./launch.ts";
import {
  detectAgain,
  instanceOf,
  OWN_PROFILE,
  plainStart,
  runColima as runColimaFor,
  withVmLock,
} from "./vm-lifecycle.ts";

export interface VmShare {
  location: string;
  writable: boolean;
}

interface MountEntry {
  keys: string[];
  values: Record<string, string>;
}

interface SharePlan {
  profile: string;
  missing: string[];
  added: VmShare[];
  next: VmShare[];
}

interface PlanRefusal {
  reason: string;
}

interface Need {
  path: string;
  writable: boolean;
}

const MOUNTS_KEY = /^mounts:\s*(.*)$/;

const ENTRY_KEY = /^([A-Za-z0-9_]+):\s*(.*)$/;

const QUOTED = /^(["'])(.*)\1$/;

const INLINE_COMMENT = /\s+#.*$/;

const PLAIN_KEYS = ["location", "writable"];

const EMPTY_VALUES = ["", "null", "~"];

const SAFE_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;

const yamlValue = (raw: string) => {
  const quoted = QUOTED.exec(raw);

  return quoted === null ? raw.replace(INLINE_COMMENT, "") : (quoted[2] ?? "");
};

const isTopLevel = (line: string) => line !== "" && !/^[\s-]/.test(line);

const mountsBlock = (text: string) => {
  const lines = text.split("\n").filter((line) => line.trim() !== "" && !line.trimStart().startsWith("#"));
  const start = lines.findIndex((line) => MOUNTS_KEY.test(line));

  if (start === -1) {
    return undefined;
  }

  const inline = yamlValue(MOUNTS_KEY.exec(lines[start] ?? "")?.[1]?.trim() ?? "");
  const rest = lines.slice(start + 1);
  const end = rest.findIndex(isTopLevel);

  if (inline !== "") {
    return inline === "[]" ? [] : "flow";
  }

  return rest.slice(0, end === -1 ? rest.length : end);
};

const groupedEntries = (block: string[]) => {
  const lines = block.map((line) => line.trimStart());
  const starts = lines.flatMap((line, index) => (line.startsWith("-") ? [index] : []));

  return starts.map((start, position) => {
    const entry = lines.slice(start, starts[position + 1] ?? lines.length);

    return [(entry[0] ?? "").slice(1).trim(), ...entry.slice(1)];
  });
};

const entryOf = (lines: string[]): MountEntry => {
  const pairs = lines.flatMap((line) => {
    const match = ENTRY_KEY.exec(line);

    return match === null ? [] : [[match[1] ?? "", yamlValue((match[2] ?? "").trim())] as const];
  });

  return { keys: pairs.map(([key]) => key), values: Object.fromEntries(pairs) };
};

const mountEntriesOf = (text: string) => {
  const block = mountsBlock(text);

  return block === undefined || block === "flow" ? block : groupedEntries(block).map(entryOf);
};

const shareOf = (entry: MountEntry, home: string): VmShare[] => {
  const location = entry.values.location;

  return location === undefined || location === ""
    ? []
    : [{ location: resolve(expandHome(location, home)), writable: entry.values.writable === "true" }];
};

export const vmSharesOf = (text: string, home: string) => {
  const entries = mountEntriesOf(text);

  return entries === undefined || entries === "flow"
    ? undefined
    : entries.flatMap((entry) => shareOf(entry, home));
};

const segmentsOf = (path: string) => path.split(sep).filter((part) => part !== "");

export const shareFor = (path: string, home: string, shares: VmShare[] = []) => {
  if (isWithin(path, home)) {
    return home;
  }

  const [top, volume] = segmentsOf(path);
  const candidate = top === "Volumes" && volume !== undefined ? join(sep, top, volume) : dirname(path);
  const shallow = segmentsOf(candidate).length < 2;
  const holdsShare = shares.some(
    (share) => share.location !== candidate && isWithin(share.location, candidate),
  );

  return shallow || isWithin(home, candidate) || holdsShare ? path : candidate;
};

const limaDir = (home: string, profile: string) => join(home, ".colima", "_lima", instanceOf(profile));

const readOptional = (path: string) => readFile(path, "utf8").catch(() => undefined);

const runningShares = async (home: string, profile: string) => {
  const text = await readOptional(join(limaDir(home, profile), "lima.yaml"));

  return text === undefined ? undefined : vmSharesOf(text, home);
};

const savedEntries = async (home: string, profile: string) => {
  const text = await readOptional(join(home, ".colima", profile, "colima.yaml"));

  return text === undefined ? undefined : (mountEntriesOf(text) ?? []);
};

const needsOf = (deps: CliDeps, context: LaunchContext): Need[] => {
  const { workspace, effective } = context;
  const sessions = hostSessionsOf(deps, context, undefined);
  const sessionsDir = "dir" in sessions ? [{ path: sessions.dir, writable: true }] : [];

  return [
    ...mountedGitDirs(workspace).map((path) => ({ path, writable: true })),
    { path: context.stateDir, writable: false },
    ...effective.config.mounts.extraReadOnly.map((path) => ({
      path: resolve(workspace.repoRoot, expandHome(path, deps.home)),
      writable: false,
    })),
    ...sessionsDir,
  ].map((need) => ({ ...need, path: realOrResolvedSync(need.path) }));
};

const covers = (shares: VmShare[], need: Need) =>
  shares.some((share) => isWithin(need.path, share.location) && (share.writable || !need.writable));

const uncovered = (shares: VmShare[], needs: Need[]) => needs.filter((need) => !covers(shares, need));

const pathsOf = (needs: Need[]) => {
  const paths = [...new Set(needs.map((need) => need.path))];

  return paths.filter((path) => !paths.some((other) => other !== path && isWithin(path, other)));
};

const mergedShares = (candidates: VmShare[]) =>
  [...new Set(candidates.map((candidate) => candidate.location))]
    .filter(
      (location) =>
        !candidates.some((other) => other.location !== location && isWithin(location, other.location)),
    )
    .map((location) => ({
      location,
      writable: candidates.some((candidate) => candidate.writable && isWithin(candidate.location, location)),
    }));

const homeFirst = (shares: VmShare[], home: string) => [
  ...shares.filter((share) => share.location === home),
  ...shares.filter((share) => share.location !== home),
];

const nextShares = (base: VmShare[], added: VmShare[], home: string) =>
  homeFirst(
    [
      ...base.map((share) =>
        added.some((entry) => entry.location === share.location && entry.writable)
          ? { ...share, writable: true }
          : share,
      ),
      ...added.filter((entry) => !base.some((share) => share.location === entry.location)),
    ],
    home,
  );

const shellWord = (word: string) => (SAFE_WORD.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`);

const mountFlags = (shares: VmShare[]) =>
  shares.flatMap((share) => ["--mount", share.writable ? `${share.location}:w` : share.location]);

const startArgs = (profile: string, shares: VmShare[]) => [
  "start",
  "--profile",
  profile,
  "--activate=false",
  ...mountFlags(shares),
];

const restartCommand = (profile: string, shares: VmShare[]) =>
  `colima stop --profile ${profile} && colima ${startArgs(profile, shares).map(shellWord).join(" ")}`;

const colimaYaml = (profile: string) => `~/.colima/${profile}/colima.yaml`;

const editHint = (profile: string) =>
  `edit ${colimaYaml(profile)} mounts, then colima stop --profile ${profile} && ${plainStart(profile)}`;

const isPlain = (entry: MountEntry) =>
  entry.keys.every(
    (key) =>
      PLAIN_KEYS.includes(key) || (key === "mountPoint" && EMPTY_VALUES.includes(entry.values[key] ?? "")),
  );

const planShares = async (
  deps: CliDeps,
  profile: string,
  needs: Need[],
): Promise<SharePlan | PlanRefusal> => {
  const entries = await savedEntries(deps.home, profile);

  if (entries === undefined || entries === "flow") {
    return { reason: `the launcher cannot read the mounts of ${colimaYaml(profile)}` };
  }

  if (!entries.every(isPlain)) {
    return { reason: `a mount in ${colimaYaml(profile)} has keys the launcher cannot pass to colima` };
  }

  const saved = entries.flatMap((entry) => shareOf(entry, deps.home));
  const base = saved.length === 0 ? [{ location: deps.home, writable: true }] : saved;
  const missing = uncovered(base, needs);
  const added = mergedShares(
    missing.map((need) => ({ location: shareFor(need.path, deps.home, base), writable: need.writable })),
  );

  return { profile, missing: pathsOf(missing), added, next: nextShares(base, added, deps.home) };
};

const locationsOf = (shares: VmShare[]) => shares.map((share) => share.location).join(", ");

const notShared = (paths: string[]) =>
  `${paths.join(", ")} ${paths.length === 1 ? "is" : "are"} not shared with the sandbox VM`;

const sessionsText = (count: number) =>
  count === 1 ? "1 running pi session" : `${count} running pi sessions`;

const manualHint = (plan: SharePlan) => `share it yourself with ${restartCommand(plan.profile, plan.next)}`;

const runColima = (deps: CliDeps, plan: SharePlan, args: string[]) =>
  runColimaFor(
    deps,
    `could not share ${locationsOf(plan.added)} with the sandbox VM`,
    args,
    `run ${plainStart(plan.profile)} and see ~/.colima/_lima/${instanceOf(plan.profile)}/ha.stderr.log`,
  );

const assertShared = async (deps: CliDeps, plan: SharePlan, needs: Need[]) => {
  const shares = await runningShares(deps.home, plan.profile);
  const missing =
    shares === undefined ? plan.added.map((share) => share.location) : pathsOf(uncovered(shares, needs));

  if (missing.length > 0) {
    throw new LauncherError(
      `colima did not share ${missing.join(", ")} with the sandbox VM`,
      `run ${restartCommand(plan.profile, plan.next)}`,
    );
  }
};

const assertLiveFree = async (context: LaunchContext, plan: SharePlan) => {
  const live = await liveSessions(context.stateDir);

  if (live.length > 0) {
    throw new LauncherError(
      `${notShared(plan.missing)}; sharing ${locationsOf(plan.added)} restarts the VM and would stop ${sessionsText(live.length)}`,
      `end them and run pi again, or ${manualHint(plan)}`,
    );
  }
};

const restartWithShares = async (
  deps: CliDeps,
  context: LaunchContext,
  backend: Backend,
  plan: SharePlan,
  needs: Need[],
) => {
  await assertLiveFree(context, plan);

  writeLine(deps.stderr, `pi-sandbox: sharing ${locationsOf(plan.added)} with the sandbox VM, one time`);

  await runColima(deps, plan, ["stop", "--profile", plan.profile]);

  await runColima(deps, plan, startArgs(plan.profile, plan.next));

  await assertShared(deps, plan, needs);

  const detection = await detectAgain(() => backend.detect());

  if (detection?.available !== true) {
    throw new LauncherError(
      `the sandbox VM did not come back after sharing ${locationsOf(plan.added)}: ${detection?.reason ?? "not detected"}`,
      `run ${plainStart(plan.profile)}`,
    );
  }
};

const droppedShares = (shares: VmShare[], plan: SharePlan) =>
  shares
    .filter((share) => !covers(plan.next, { path: share.location, writable: share.writable }))
    .map((share) => share.location);

const shareMissing = async (
  deps: CliDeps,
  context: LaunchContext,
  backend: Backend,
  profile: string,
  needs: Need[],
) => {
  const shares = await runningShares(deps.home, profile);

  if (shares === undefined || uncovered(shares, needs).length === 0) {
    return;
  }

  const plan = await planShares(deps, profile, needs);

  if ("reason" in plan) {
    throw new LauncherError(
      `${notShared(pathsOf(uncovered(shares, needs)))}; ${plan.reason}`,
      editHint(profile),
    );
  }

  const dropped = droppedShares(shares, plan);

  if (dropped.length > 0) {
    throw new LauncherError(
      `sharing ${locationsOf(plan.added)} would drop ${dropped.join(", ")} from the sandbox VM; refusing`,
      editHint(profile),
    );
  }

  await restartWithShares(deps, context, backend, plan, needs);
};

const shareWhenMissing = async (deps: CliDeps, context: LaunchContext, backend: Backend) => {
  const profile = OWN_PROFILE;
  const needs = needsOf(deps, context);
  const shares = await runningShares(deps.home, profile);

  if (shares === undefined || uncovered(shares, needs).length === 0) {
    return;
  }

  await withVmLock(context.stateDir, () => shareMissing(deps, context, backend, profile, needs));
};

export const ensureVmShares = async (deps: CliDeps, context: LaunchContext, backend: Backend) => {
  try {
    await shareWhenMissing(deps, context, backend);
  } catch (error) {
    throw withFallbackHint(error, context.effective.config.fallback);
  }
};

const missingShareLine = async (deps: CliDeps, profile: string, needs: Need[], missing: string[]) => {
  const subject = `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not shared with profile ${profile}`;
  const plan = await planShares(deps, profile, needs);

  if ("reason" in plan) {
    return failed(`${subject}; ${plan.reason}; ${editHint(profile)}`);
  }

  const command = restartCommand(profile, plan.next);

  return failed(
    `${subject}; run pi here once (it shares ${locationsOf(plan.added)} and restarts the VM) or ${command}`,
  );
};

export const checkVmShares = async (
  deps: CliDeps,
  context: LaunchContext,
  backend: Backend | undefined,
): Promise<CheckResult> => {
  if (backend === undefined) {
    return skipped("no runtime");
  }

  const profile = OWN_PROFILE;
  const shares = await runningShares(deps.home, profile);

  if (shares === undefined) {
    return skipped(`colima did not report the shares of profile ${profile}`);
  }

  const needs = needsOf(deps, context);
  const missing = pathsOf(uncovered(shares, needs));

  return missing.length === 0
    ? passed(`profile ${profile} shares ${locationsOf(shares)}; this repository is covered`)
    : missingShareLine(deps, profile, needs, missing);
};
