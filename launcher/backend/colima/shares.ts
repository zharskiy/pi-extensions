import { readFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { isWithin, LauncherError } from "../../shared/index.ts";
import type { VmCoverage, VmPath, VmShare, VmShareOptions } from "../types.ts";
import { isPlain, mountEntriesOf, shareOf, vmSharesOf } from "./colima-yaml.ts";
import { type Colima, instanceOf, logHint, plainStart } from "./profile.ts";

interface SharePlan {
  missing: string[];
  added: VmShare[];
  next: VmShare[];
}

interface PlanRefusal {
  reason: string;
}

const SAFE_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;

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

const readOptional = (path: string) => readFile(path, "utf8").catch(() => undefined);

const covers = (shares: VmShare[], need: VmPath) =>
  shares.some((share) => isWithin(need.path, share.location) && (share.writable || !need.writable));

const uncovered = (shares: VmShare[], needs: VmPath[]) => needs.filter((need) => !covers(shares, need));

const pathsOf = (needs: VmPath[]) => {
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

const locationsOf = (shares: VmShare[]) => shares.map((share) => share.location).join(", ");

const notShared = (paths: string[]) =>
  `${paths.join(", ")} ${paths.length === 1 ? "is" : "are"} not shared with the sandbox VM`;

const sessionsText = (count: number) =>
  count === 1 ? "1 running pi session" : `${count} running pi sessions`;

const droppedShares = (shares: VmShare[], plan: SharePlan) =>
  shares
    .filter((share) => !covers(plan.next, { path: share.location, writable: share.writable }))
    .map((share) => share.location);

export const createColimaShares = (colima: Colima) => {
  const { home, profile } = colima;

  const runningShares = async () => {
    const text = await readOptional(join(home, ".colima", "_lima", instanceOf(profile), "lima.yaml"));

    return text === undefined ? undefined : vmSharesOf(text, home);
  };

  const savedEntries = async () => {
    const text = await readOptional(join(home, ".colima", profile, "colima.yaml"));

    return text === undefined ? undefined : (mountEntriesOf(text) ?? []);
  };

  const planShares = async (needs: VmPath[]): Promise<SharePlan | PlanRefusal> => {
    const entries = await savedEntries();

    if (entries === undefined || entries === "flow") {
      return { reason: `the launcher cannot read the mounts of ${colimaYaml(profile)}` };
    }

    if (!entries.every(isPlain)) {
      return { reason: `a mount in ${colimaYaml(profile)} has keys the launcher cannot pass to colima` };
    }

    const saved = entries.flatMap((entry) => shareOf(entry, home));
    const base = saved.length === 0 ? [{ location: home, writable: true }] : saved;
    const missing = uncovered(base, needs);
    const added = mergedShares(
      missing.map((need) => ({ location: shareFor(need.path, home, base), writable: need.writable })),
    );

    return { missing: pathsOf(missing), added, next: nextShares(base, added, home) };
  };

  const run = (plan: SharePlan, args: string[]) =>
    colima.run(
      `could not share ${locationsOf(plan.added)} with the sandbox VM`,
      args,
      `run ${plainStart(profile)} and see ${logHint(profile)}`,
    );

  const assertShared = async (plan: SharePlan, needs: VmPath[]) => {
    const shares = await runningShares();
    const missing =
      shares === undefined ? plan.added.map((share) => share.location) : pathsOf(uncovered(shares, needs));

    if (missing.length > 0) {
      throw new LauncherError(
        `colima did not share ${missing.join(", ")} with the sandbox VM`,
        `run ${restartCommand(profile, plan.next)}`,
      );
    }
  };

  const assertIdle = async (plan: SharePlan, busy: VmShareOptions["busy"]) => {
    const count = await busy();

    if (count > 0) {
      throw new LauncherError(
        `${notShared(plan.missing)}; sharing ${locationsOf(plan.added)} restarts the VM and would stop ${sessionsText(count)}`,
        `end them and run pi again, or share it yourself with ${restartCommand(profile, plan.next)}`,
      );
    }
  };

  const restartWithShares = async (plan: SharePlan, needs: VmPath[], options: VmShareOptions) => {
    await assertIdle(plan, options.busy);

    options.report(`sharing ${locationsOf(plan.added)} with the sandbox VM, one time`);

    await run(plan, ["stop", "--profile", profile]);

    await run(plan, startArgs(profile, plan.next));

    await assertShared(plan, needs);

    const detection = await colima.detectAgain();

    if (detection?.available !== true) {
      throw new LauncherError(
        `the sandbox VM did not come back after sharing ${locationsOf(plan.added)}: ${detection?.reason ?? "not detected"}`,
        `run ${plainStart(profile)}`,
      );
    }
  };

  const shareMissing = async (needs: VmPath[], options: VmShareOptions) => {
    const shares = await runningShares();

    if (shares === undefined || uncovered(shares, needs).length === 0) {
      return;
    }

    const plan = await planShares(needs);

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

    await restartWithShares(plan, needs, options);
  };

  const ensureShares = async (needs: VmPath[], options: VmShareOptions) => {
    const shares = await runningShares();

    if (shares === undefined || uncovered(shares, needs).length === 0) {
      return;
    }

    await colima.withLock(() => shareMissing(needs, options));
  };

  const coverage = async (needs: VmPath[]): Promise<VmCoverage | undefined> => {
    const shares = await runningShares();

    return shares === undefined ? undefined : { shares, missing: pathsOf(uncovered(shares, needs)) };
  };

  return { ensureShares, coverage };
};
