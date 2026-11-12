import { readFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { isWithin, LauncherError } from "../../shared/index.ts";
import type { VmCoverage, VmPath, VmShare, VmShareOptions } from "../types.ts";
import { movedMountsOf, vmSharesOf } from "./colima-yaml.ts";
import { type Colima, instanceOf, logHint, plainStart } from "./profile.ts";

interface SharePlan {
  missing: string[];
  added: VmShare[];
  next: VmShare[];
}

interface Restart {
  change: string;
  failure: string;
}

const UNREADABLE =
  "the shares of the sandbox VM could not be read from colima's lima.yaml, so they were not changed";

const SAFE_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;

const segmentsOf = (path: string) => path.split(sep).filter((part) => part !== "");

export const shareFor = (path: string, home: string) => {
  if (isWithin(path, home)) {
    return home;
  }

  const [top, volume] = segmentsOf(path);
  const candidate = top === "Volumes" && volume !== undefined ? join(sep, top, volume) : dirname(path);
  const shallow = segmentsOf(candidate).length < 2;

  return shallow || isWithin(home, candidate) ? path : candidate;
};

const readOptional = (path: string) => readFile(path, "utf8").catch(() => undefined);

const covers = (shares: VmShare[], need: VmPath) =>
  shares.some((share) => isWithin(need.path, share.location) && (share.writable || !need.writable));

const uncovered = (shares: VmShare[], needs: VmPath[]) => needs.filter((need) => !covers(shares, need));

const pathsOf = (needs: VmPath[]) => {
  const paths = [...new Set(needs.map((need) => need.path))];

  return paths.filter((path) => !paths.some((other) => other !== path && isWithin(path, other)));
};

const merged = (shares: VmShare[]) =>
  [...new Set(shares.map((share) => share.location))]
    .filter(
      (location) =>
        !shares.some((other) => other.location !== location && isWithin(location, other.location)),
    )
    .map((location) => ({
      location,
      writable: shares.some((share) => share.writable && isWithin(share.location, location)),
    }));

const homeFirst = (shares: VmShare[], home: string) => [
  ...shares.filter((share) => share.location === home),
  ...shares.filter((share) => share.location !== home),
];

const nextShares = (base: VmShare[], needs: VmPath[], home: string) =>
  homeFirst(
    merged([
      ...base,
      ...uncovered(base, needs).map((need) => ({
        location: shareFor(need.path, home),
        writable: need.writable,
      })),
    ]),
    home,
  );

const planOf = (current: VmShare[], needs: VmPath[], home: string): SharePlan => {
  const next = nextShares(current, needs, home);

  return {
    missing: pathsOf(uncovered(current, needs)),
    added: next.filter(
      (share) =>
        !current.some((have) => have.location === share.location && (have.writable || !share.writable)),
    ),
    next,
  };
};

const shellWord = (word: string) => (SAFE_WORD.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`);

export const shareText = (share: VmShare) => (share.writable ? `${share.location}:w` : share.location);

const mountFlags = (shares: VmShare[]) => shares.flatMap((share) => ["--mount", shareText(share)]);

export const startArgs = (profile: string, shares: VmShare[]) => [
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

const sameShare = (share: VmShare) => (other: VmShare) =>
  other.location === share.location && other.writable === share.writable;

export const shareDrift = (current: VmShare[], desired: VmShare[]) => ({
  extra: current.filter((share) => !desired.some(sameShare(share))),
  lacking: desired.filter((share) => !current.some(sameShare(share))),
});

const isDrifted = (current: VmShare[], desired: VmShare[]) => {
  const { extra, lacking } = shareDrift(current, desired);

  return extra.length > 0 || lacking.length > 0;
};

const exactPlan = (current: VmShare[], desired: VmShare[], needs: VmPath[]): SharePlan => ({
  missing: pathsOf(uncovered(current, needs)),
  added: shareDrift(current, desired).lacking,
  next: desired,
});

export const createColimaShares = (colima: Colima) => {
  const { home, profile } = colima;

  const limaYaml = () => readOptional(join(home, ".colima", "_lima", instanceOf(profile), "lima.yaml"));

  const runningShares = async () => {
    const text = await limaYaml();

    return text === undefined ? undefined : vmSharesOf(text, home);
  };

  const readShares = async () => {
    const text = await limaYaml();

    if (text === undefined) {
      return undefined;
    }

    return vmSharesOf(text, home) ?? "unreadable";
  };

  const run = (failure: string, args: string[]) =>
    colima.run(failure, args, `run ${plainStart(profile)} and see ${logHint(profile)}`);

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

  const busyError = (plan: SharePlan, count: number, change: string) =>
    new LauncherError(
      `${notShared(plan.missing)}; ${change} restarts the VM and would stop ${sessionsText(count)}`,
      `end them and run pi again, or share it yourself with ${restartCommand(profile, plan.next)}`,
    );

  const restartWith = async (plan: SharePlan, needs: VmPath[], { change, failure }: Restart) => {
    await run(failure, ["stop", "--profile", profile]);

    await run(failure, startArgs(profile, plan.next));

    await assertShared(plan, needs);

    const detection = await colima.detectAgain();

    if (detection?.available !== true) {
      throw new LauncherError(
        `the sandbox VM did not come back after ${change}: ${detection?.reason ?? "not detected"}`,
        `run ${plainStart(profile)}`,
      );
    }
  };

  const restartWithShares = async (plan: SharePlan, needs: VmPath[], options: VmShareOptions) => {
    const change = `sharing ${locationsOf(plan.added)}`;
    const count = await options.busy();

    if (count > 0) {
      throw busyError(plan, count, change);
    }

    options.report(`sharing ${locationsOf(plan.added)} with the sandbox VM, one time`);

    await restartWith(plan, needs, {
      change,
      failure: `could not share ${locationsOf(plan.added)} with the sandbox VM`,
    });
  };

  const shareMissing = async (needs: VmPath[], options: VmShareOptions) => {
    const text = (await limaYaml()) ?? "";
    const shares = vmSharesOf(text, home);

    if (shares === undefined || uncovered(shares, needs).length === 0) {
      return;
    }

    const moved = movedMountsOf(text, home);

    if (moved.length > 0) {
      throw new LauncherError(
        `${notShared(pathsOf(uncovered(shares, needs)))}; ${moved.join(", ")} ${moved.length === 1 ? "is" : "are"} mounted at another path in the VM, which colima's --mount cannot keep`,
        editHint(profile),
      );
    }

    await restartWithShares(planOf(shares, needs, home), needs, options);
  };

  const ensureShares = async (needs: VmPath[], options: VmShareOptions) => {
    const shares = await runningShares();

    if (shares === undefined || uncovered(shares, needs).length === 0) {
      return;
    }

    await colima.withLock(() => shareMissing(needs, options));
  };

  const assertDesiredCovers = (desired: VmShare[], needs: VmPath[]) => {
    const outside = pathsOf(uncovered(desired, needs));

    if (outside.length > 0) {
      throw new LauncherError(
        `${outside.join(", ")} ${outside.length === 1 ? "lies" : "lie"} outside the shares workspaceRoots gives the sandbox VM`,
        "start pi inside one of the workspaceRoots, or add the folder to workspaceRoots.roots",
      );
    }
  };

  const keepWhileBusy = (plan: SharePlan, count: number, report: VmShareOptions["report"]) => {
    if (plan.missing.length > 0) {
      throw busyError(plan, count, "changing its shares to the workspaceRoots");
    }

    report(
      "the sandbox VM keeps its current shares while other pi sessions run; they change to the workspaceRoots at the next launch with no pi session running",
    );
  };

  const reconcileDrift = async (desired: VmShare[], needs: VmPath[], options: VmShareOptions) => {
    const shares = vmSharesOf((await limaYaml()) ?? "", home);

    if (shares === undefined || !isDrifted(shares, desired)) {
      return;
    }

    const plan = exactPlan(shares, desired, needs);
    const count = await options.busy();

    if (count > 0) {
      keepWhileBusy(plan, count, options.report);

      return;
    }

    options.report(`restarting the sandbox VM to change its shares to ${locationsOf(desired)}`);

    await restartWith(plan, needs, {
      change: "changing its shares",
      failure: "could not change the shares of the sandbox VM",
    });
  };

  const reconcileShares = async (desired: VmShare[], needs: VmPath[], options: VmShareOptions) => {
    assertDesiredCovers(desired, needs);

    const shares = await readShares();

    if (shares === "unreadable") {
      options.report(UNREADABLE);

      return;
    }

    if (shares === undefined || !isDrifted(shares, desired)) {
      return;
    }

    await colima.withLock(() => reconcileDrift(desired, needs, options));
  };

  const coverage = async (needs: VmPath[]): Promise<VmCoverage | "unreadable" | undefined> => {
    const shares = await readShares();

    if (shares === undefined || shares === "unreadable") {
      return shares;
    }

    return { shares, missing: pathsOf(uncovered(shares, needs)) };
  };

  return { ensureShares, reconcileShares, coverage };
};
