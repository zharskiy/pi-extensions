import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type CommandRunner,
  errorMessage,
  LauncherError,
  lastLine,
  stateLayout,
  withDirectoryLock,
  withDirectoryLockIfFree,
} from "../../shared/index.ts";
import type {
  Detection,
  Vm,
  VmApplied,
  VmApplyOptions,
  VmBusy,
  VmDesired,
  VmInspect,
  VmPath,
  VmReconcile,
  VmReport,
  VmShare,
  VmShareOptions,
  VmTarget,
} from "../types.ts";
import {
  shareDrift,
  type VmChange,
  type VmFound,
  type VmWanted,
  vmDecision,
  whenBusy,
} from "../vm-decision.ts";
import { vmSizeText } from "../vm-size.ts";
import { vmSharesOf, vmSizeOfYaml } from "./colima-yaml.ts";
import { createFileCacheGuard, processAlive, type Ticker, watchFileCache } from "./file-cache.ts";
import {
  busyText,
  type Colima,
  deferredWhileBusy,
  ENGINE_PROFILE,
  ENGINE_SOCKET_DISPLAY,
  instanceOf,
  logHint,
  PI_STARTS_VM,
  plainStart,
  restartText,
  startArgs,
} from "./profile.ts";
import {
  assertDesiredCovers,
  createColimaShares,
  locationsOf,
  notShared,
  UNREADABLE,
  uncoveredPaths,
} from "./shares.ts";
import { coldStartSize, completeSize, shrinkNotice, statusSize } from "./size.ts";
import { createColimaTrust } from "./vm-trust.ts";

export interface ColimaVmOptions {
  home: string;
  stateDir: string;
  runner: CommandRunner;
  detect: () => Promise<Detection>;
  pause?: (ms: number) => Promise<void>;
  now?: () => number;
  ticker?: Ticker;
}

const LOCK_TIMEOUT_MS = 180_000;

const DETECT_DELAYS_MS = [0, 500, 1000, 1500, 2000];

const START_FAILURE = "could not start the sandbox VM";

const STOP_FAILURE = "could not stop the sandbox VM";

const CREATE_FAILURE = "could not create the sandbox VM";

const RESTART_FAILURE = "could not restart the sandbox VM";

const startHint = (shares: VmShare[]) =>
  `run ${plainStart(ENGINE_PROFILE, shares)} and see ${logHint(ENGINE_PROFILE)}`;

const INIT_HINT = "run pi sandbox init, which creates it";

const NOT_BUSY: VmBusy = { count: 0, others: [] };

const DISK_NAMES = ["disk", "diffdisk"];

const vmDiskPaths = (home: string, profile: string) => {
  const lima = join(home, ".colima", "_lima");

  return [
    ...DISK_NAMES.map((name) => join(lima, instanceOf(profile), name)),
    join(lima, "_disks", instanceOf(profile), "datadisk"),
  ];
};

export const engineUnreachable = (detection?: Detection) =>
  new LauncherError(
    `the sandbox VM engine is unreachable at ${ENGINE_SOCKET_DISPLAY}${detection?.reason === undefined ? "" : `: ${detection.reason}`}`,
    `${PI_STARTS_VM}, or pi sandbox init when ~/.colima/${ENGINE_PROFILE} does not exist`,
  );

const profileAbsent = () =>
  new LauncherError(`the sandbox VM does not exist: there is no colima profile ${ENGINE_PROFILE}`, INIT_HINT);

const engineSilent = (detection: Detection) =>
  new LauncherError(
    `the sandbox VM is running but its engine at ${ENGINE_SOCKET_DISPLAY} does not answer: ${detection.reason ?? "not detected"}`,
    `run pi sandbox stop, then pi again, and see ${logHint(ENGINE_PROFILE)}`,
  );

const assertPlanned = (shares: VmShare[]) => {
  if (shares.length === 0) {
    throw new LauncherError(
      "the sandbox VM may not start without the folders it shares, or colima would share the home dir",
      "set workspaceRoot (pi sandbox init), then run pi again",
    );
  }
};

const realPause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

interface Restart {
  plan: VmShare[];
  mounts: VmShare[];
  added: VmShare[];
  previous?: VmShare[];
  resize: VmTarget;
}

const missingFrom = (shares: VmShare[], others: VmShare[]) =>
  shares.filter((share) => !others.some((other) => other.location === share.location));

const shareDelta = (restart: Restart) => {
  if (restart.previous === undefined) {
    return "";
  }

  const adds = missingFrom(restart.mounts, restart.previous);
  const drops = missingFrom(restart.previous, restart.mounts);
  const parts = [
    ...(adds.length === 0 || adds.length === restart.mounts.length ? [] : [`adds ${locationsOf(adds)}`]),
    ...(drops.length === 0 ? [] : [`drops ${locationsOf(drops)}`]),
  ];

  return parts.length === 0 ? "" : ` (${parts.join(", ")})`;
};

const changeText = (restart: Restart) => {
  const reshared = restart.mounts.length > 0;
  const resized = Object.keys(restart.resize).length > 0;
  const changed = [
    ...(reshared ? [`its shares to ${locationsOf(restart.mounts)}${shareDelta(restart)}`] : []),
    ...(resized ? [`its size to ${vmSizeText(restart.resize)}`] : []),
  ];

  return `change ${changed.join(", and ")}`;
};

export const createColimaVm = (options: ColimaVmOptions): Vm => {
  const { home, runner, detect, pause = realPause } = options;
  const profile = ENGINE_PROFILE;
  const colimaRun = (args: string[], extra: { input?: string; timeoutMs?: number } = {}) =>
    runner.run("colima", args, { env: { COLIMA_HOME: join(home, ".colima") }, ...extra });

  const run = async (failure: string, args: string[], hint: string) => {
    const result = await colimaRun(args).catch((error: unknown) => {
      throw new LauncherError(
        `${failure}: ${errorMessage(error)}`,
        error instanceof LauncherError ? error.hint : undefined,
      );
    });

    if (result.code !== 0) {
      throw new LauncherError(
        `${failure}: colima ${args[0]} failed: ${lastLine(result.stderr) || `exit ${result.code}`}`,
        hint,
      );
    }
  };

  const detectAgain = (delaysMs = DETECT_DELAYS_MS) =>
    delaysMs.reduce<Promise<Detection | undefined>>(async (previous, delay) => {
      const last = await previous;

      if (last?.available === true) {
        return last;
      }

      await pause(delay);

      return detect();
    }, Promise.resolve(undefined));

  const withLock = <T>(action: () => Promise<T>) =>
    withDirectoryLock(stateLayout(options.stateDir).vmLock, action, { timeoutMs: LOCK_TIMEOUT_MS });

  const colima: Colima = {
    home,
    profile,
    run,
    detectAgain,
    withLock,
  };
  const shares = createColimaShares(colima);
  const vmShell = (command: string[], extra?: { input?: string; timeoutMs?: number }) =>
    colimaRun(["ssh", "--profile", profile, "--", ...command], extra);
  const trust = createColimaTrust(colima, vmShell);
  const fileCache = createFileCacheGuard({
    runner,
    diskPaths: vmDiskPaths(home, profile),
    shell: vmShell,
    lockIfFree: (action) => withDirectoryLockIfFree(stateLayout(options.stateDir).vmLock, action),
    alive: processAlive,
    now: options.now ?? Date.now,
  });

  const profileYaml = join(home, ".colima", profile, "colima.yaml");

  const profileExists = () =>
    access(profileYaml).then(
      () => true,
      () => false,
    );

  const readProfileYaml = () => readFile(profileYaml, "utf8").catch(() => undefined);

  const running = async (failure: string) => {
    const result = await colimaRun(["status", "--profile", profile]).catch((error: unknown) => {
      throw new LauncherError(
        `${failure}: ${errorMessage(error)}`,
        "install colima, then run pi sandbox init",
      );
    });

    return result.code === 0;
  };

  const startStopped = async (report: VmReport, shares: VmShare[], target: VmTarget) => {
    assertPlanned(shares);

    const coldSize = coldStartSize(await readProfileYaml(), target, report);

    report("starting the sandbox VM");

    await run(START_FAILURE, startArgs(profile, { shares, size: coldSize }), startHint(shares));

    const detection = await detectAgain();

    if (detection?.available !== true) {
      throw new LauncherError(
        `the sandbox VM started but its engine is unreachable: ${detection?.reason ?? "not detected"}`,
        startHint(shares),
      );
    }
  };

  const ensureUp = (report: VmReport, shares: VmShare[], target: VmTarget) =>
    withLock(async () => {
      const detection = await detect();

      if (detection.available) {
        return;
      }

      if (!(await profileExists())) {
        throw profileAbsent();
      }

      if (await running(START_FAILURE)) {
        throw engineSilent(detection);
      }

      await startStopped(report, shares, target);
    });

  const ensureRunning = async (report: VmReport, shares: VmShare[], target: VmTarget = {}) => {
    await ensureUp(report, shares, target);

    trust.readEarly();
  };

  const refuseBusy = async (busy: VmShareOptions["busy"]) => {
    const sessions = await busy();

    if (sessions.count > 0) {
      throw new LauncherError(
        `${busyText(sessions)}; stopping the sandbox VM would end them`,
        "exit them and run pi sandbox stop again",
      );
    }
  };

  const stop: Vm["stop"] = async ({ busy }) => {
    if (!(await profileExists())) {
      return "absent";
    }

    if (!(await running(STOP_FAILURE))) {
      return "already stopped";
    }

    await refuseBusy(busy);

    await withLock(async () => {
      await refuseBusy(busy);

      await run(STOP_FAILURE, ["stop", "--profile", profile], `see ${logHint(profile)}`);
    });

    return "stopped";
  };

  const size = () => statusSize(colimaRun, profile).catch(() => undefined);

  const inspect = async (): Promise<VmInspect> => {
    const text = await readProfileYaml();

    if (text === undefined) {
      return { state: "absent" };
    }

    const measured = await statusSize(colimaRun, profile);
    const configured = vmSizeOfYaml(text);

    if (measured === undefined) {
      return {
        state: "stopped",
        size: completeSize(profile, undefined, configured),
        shares: vmSharesOf(text, home) ?? "unreadable",
      };
    }

    return {
      state: "running",
      size: completeSize(profile, measured, configured),
      shares: (await shares.readShares()) ?? "unreadable",
    };
  };

  const waitForEngine = async (change: string, progress: VmApplyOptions["progress"], plan: VmShare[]) => {
    progress("waiting");

    const detection = await detectAgain();

    if (detection?.available !== true) {
      throw new LauncherError(
        `the sandbox VM did not come back after ${change}: ${detection?.reason ?? "not detected"}`,
        startHint(plan),
      );
    }
  };

  const create = async (desired: VmDesired, progress: VmApplyOptions["progress"]) => {
    assertPlanned(desired.shares);

    progress("creating");

    await run(
      CREATE_FAILURE,
      startArgs(profile, { shares: desired.shares, size: desired.size, create: true }),
      `see ${logHint(profile)}, then run pi sandbox init again`,
    );

    await waitForEngine("creating it", progress, desired.shares);
  };

  const decide = async (found: VmFound, wanted: VmWanted, busy: VmShareOptions["busy"]) => {
    const decision = vmDecision(found, wanted);
    const sessions = decision.kind === "restart" ? await busy() : NOT_BUSY;

    return { decision: whenBusy(decision, sessions.count), sessions };
  };

  const restartOf = (found: VmFound, wanted: VmWanted, change: VmChange): Restart => {
    const plan = wanted.shares ?? [];

    if (!change.reshare || wanted.shares === undefined || found.state === "absent") {
      return { plan, mounts: [], added: [], resize: change.resize };
    }

    if (found.shares === "unreadable") {
      return { plan, mounts: plan, added: plan, resize: change.resize };
    }

    const added = shareDrift(found.shares, plan).lacking;

    return { plan, mounts: plan, added, previous: found.shares, resize: change.resize };
  };

  const restart = async (planned: Restart, progress: VmApplyOptions["progress"], needs?: VmPath[]) => {
    progress("stopping");

    await run(RESTART_FAILURE, ["stop", "--profile", profile], `see ${logHint(profile)}`);

    progress("starting");

    await run(
      RESTART_FAILURE,
      startArgs(profile, { shares: planned.mounts, size: planned.resize }),
      startHint(planned.plan),
    );

    if (needs !== undefined && planned.mounts.length > 0) {
      await shares.assertShared(planned.added, needs, planned.mounts);
    }

    await waitForEngine("restarting it", progress, planned.plan);
  };

  const applyLocked = async (desired: VmDesired, options: VmApplyOptions): Promise<VmApplied> => {
    const found = await inspect();
    const { decision } = await decide(found, desired, options.busy);

    if (decision.kind === "create") {
      await create(desired, options.progress);

      return "created";
    }

    if (decision.kind === "defer") {
      return { deferred: decision.sessions };
    }

    if (decision.kind !== "restart") {
      return found.state === "stopped" ? "stopped" : "unchanged";
    }

    await restart(restartOf(found, desired, decision), options.progress);

    return "restarted";
  };

  const refused = (missing: string[], sessions: VmBusy, text: string, mounts: VmShare[]) =>
    new LauncherError(
      `${notShared(missing)}; ${busyText(sessions)}, and restarting the VM to ${text} would end them`,
      `end them and run pi again, or share it yourself with ${restartText(profile, { shares: mounts })}`,
    );

  const reconcileLocked = async (target: VmReconcile, options: VmShareOptions) => {
    assertDesiredCovers(target.shares, target.needs);

    const read = await shares.readShares();

    const current = Array.isArray(read) ? read : undefined;
    const wanted: VmWanted = { size: target.size, shares: target.shares };
    const found: VmFound = {
      state: "running",
      size: Object.keys(target.size).length === 0 ? undefined : await size(),
      shares: current ?? "unreadable",
    };
    const { decision, sessions } = await decide(found, wanted, options.busy);
    const changesVm = decision.kind === "restart" || decision.kind === "defer";

    if (read === "unreadable" && decision.kind !== "restart") {
      options.report(UNREADABLE);
    }

    if ("keptDiskGiB" in decision && decision.keptDiskGiB !== undefined) {
      options.report(shrinkNotice(target.size, decision.keptDiskGiB));
    }

    if (!changesVm) {
      return;
    }

    const planned = restartOf(found, wanted, decision);
    const text = changeText(planned);

    if (decision.kind === "defer") {
      const missing = current === undefined ? [] : uncoveredPaths(current, target.needs);

      if (missing.length > 0) {
        throw refused(missing, sessions, text, planned.mounts);
      }

      options.report(deferredWhileBusy(text, sessions));

      return;
    }

    options.report(`restarting the sandbox VM to ${text}`);

    await restart(planned, () => undefined, target.needs);
  };

  return {
    watchFileCache: () => watchFileCache(fileCache, options.ticker),
    readFileCache: fileCache.read,
    inspect,
    apply: (desired, options) => withLock(() => applyLocked(desired, options)),
    ensureRunning,
    coverage: shares.coverage,
    reconcile: (target, options) => withLock(() => reconcileLocked(target, options)),
    ensureTrust: trust.ensureTrust,
    size,
    stop,
  };
};
