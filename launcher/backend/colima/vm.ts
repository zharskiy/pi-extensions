import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type CommandRunner,
  errorMessage,
  LauncherError,
  stateLayout,
  withDirectoryLock,
} from "../../shared/index.ts";
import type {
  Detection,
  Vm,
  VmApplied,
  VmApplyOptions,
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
import {
  type Colima,
  deferredUntilIdle,
  ENGINE_PROFILE,
  ENGINE_SOCKET_DISPLAY,
  lastLine,
  logHint,
  plainStart,
  restartText,
  sessionsRunning,
  startArgs,
} from "./profile.ts";
import {
  assertDesiredCovers,
  createColimaShares,
  locationsOf,
  notShared,
  restartedShares,
  sharesFor,
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
}

const LOCK_TIMEOUT_MS = 180_000;

const DETECT_DELAYS_MS = [0, 500, 1000, 1500, 2000];

const START_FAILURE = "could not start the sandbox VM";

const STOP_FAILURE = "could not stop the sandbox VM";

const CREATE_FAILURE = "could not create the sandbox VM";

const RESTART_FAILURE = "could not restart the sandbox VM";

const MOVED_PROBLEM = "could not change the shares of the sandbox VM";

const startHint = `run ${plainStart(ENGINE_PROFILE)} and see ${logHint(ENGINE_PROFILE)}`;

const INIT_HINT = "run pi sandbox init, which creates it";

export const engineUnreachable = (detection?: Detection) =>
  new LauncherError(
    `the sandbox VM engine is unreachable at ${ENGINE_SOCKET_DISPLAY}${detection?.reason === undefined ? "" : `: ${detection.reason}`}`,
    `run ${plainStart(ENGINE_PROFILE)}, or pi sandbox init when ~/.colima/${ENGINE_PROFILE} does not exist`,
  );

const profileAbsent = () =>
  new LauncherError(`the sandbox VM does not exist: there is no colima profile ${ENGINE_PROFILE}`, INIT_HINT);

const engineSilent = (detection: Detection) =>
  new LauncherError(
    `the sandbox VM is running but its engine at ${ENGINE_SOCKET_DISPLAY} does not answer: ${detection.reason ?? "not detected"}`,
    `run ${restartText(ENGINE_PROFILE)} and see ${logHint(ENGINE_PROFILE)}`,
  );

const realPause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

interface Restart {
  mounts: VmShare[];
  added: VmShare[];
  resize: VmTarget;
}

const changeText = (wanted: VmWanted, restart: Restart) => {
  const reshared = restart.mounts.length > 0;
  const resized = Object.keys(restart.resize).length > 0;
  const changed = [
    ...(reshared && wanted.exactShares ? [`its shares to ${locationsOf(restart.mounts)}`] : []),
    ...(resized ? [`its size to ${vmSizeText(restart.resize)}`] : []),
  ];

  return [
    ...(reshared && !wanted.exactShares ? [`share ${locationsOf(restart.added)}`] : []),
    ...(changed.length > 0 ? [`change ${changed.join(", and ")}`] : []),
  ].join(", and ");
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
  const trust = createColimaTrust(colima, (command, extra) =>
    colimaRun(["ssh", "--profile", profile, "--", ...command], extra),
  );

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
    const coldSize = coldStartSize(await readProfileYaml(), target, report);

    report("starting the sandbox VM");

    await run(START_FAILURE, startArgs(profile, { shares, size: coldSize }), startHint);

    const detection = await detectAgain();

    if (detection?.available !== true) {
      throw new LauncherError(
        `the sandbox VM started but its engine is unreachable: ${detection?.reason ?? "not detected"}`,
        startHint,
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

  const ensureRunning = async (report: VmReport, shares: VmShare[] = [], target: VmTarget = {}) => {
    await ensureUp(report, shares, target);

    trust.readEarly();
  };

  const refuseBusy = async (busy: VmShareOptions["busy"]) => {
    const count = await busy();

    if (count > 0) {
      throw new LauncherError(
        `${sessionsRunning(count)}; stopping the sandbox VM would end them`,
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

  const waitForEngine = async (change: string, progress: VmApplyOptions["progress"]) => {
    progress("waiting");

    const detection = await detectAgain();

    if (detection?.available !== true) {
      throw new LauncherError(
        `the sandbox VM did not come back after ${change}: ${detection?.reason ?? "not detected"}`,
        startHint,
      );
    }
  };

  const create = async (desired: VmDesired, progress: VmApplyOptions["progress"]) => {
    progress("creating");

    await run(
      CREATE_FAILURE,
      startArgs(profile, { shares: desired.shares, size: desired.size, create: true }),
      `see ${logHint(profile)}, then run pi sandbox init again`,
    );

    await waitForEngine("creating it", progress);
  };

  const decide = async (found: VmFound, wanted: VmWanted, busy: () => Promise<number>) => {
    const decision = vmDecision(found, wanted);

    return decision.kind === "restart" ? whenBusy(decision, await busy()) : decision;
  };

  const restartOf = (found: VmFound, wanted: VmWanted, change: VmChange): Restart => {
    if (!change.reshare || wanted.shares === undefined || found.state === "absent") {
      return { mounts: [], added: [], resize: change.resize };
    }

    const mounts = restartedShares(found.shares, wanted.shares, wanted.exactShares, home);
    const added = found.shares === "unreadable" ? mounts : shareDrift(found.shares, mounts).lacking;

    return { mounts, added, resize: change.resize };
  };

  const restart = async (
    wanted: VmWanted,
    planned: Restart,
    needs: VmPath[],
    progress: VmApplyOptions["progress"],
  ) => {
    if (planned.mounts.length > 0 && !wanted.exactShares) {
      await shares.keepsMoved(MOVED_PROBLEM);
    }

    progress("stopping");

    await run(RESTART_FAILURE, ["stop", "--profile", profile], `see ${logHint(profile)}`);

    progress("starting");

    await run(
      RESTART_FAILURE,
      startArgs(profile, { shares: planned.mounts, size: planned.resize }),
      startHint,
    );

    if (planned.mounts.length > 0) {
      await shares.assertShared(planned.added, needs, planned.mounts);
    }

    await waitForEngine("restarting it", progress);
  };

  const applyLocked = async (desired: VmDesired, options: VmApplyOptions): Promise<VmApplied> => {
    const found = await inspect();
    const decision = await decide(found, desired, options.busy);

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

    await restart(desired, restartOf(found, desired, decision), [], options.progress);

    return "restarted";
  };

  const launchWanted = (target: VmReconcile, current: VmShare[] | undefined): VmWanted => {
    if (current === undefined) {
      return { size: target.size, exactShares: false };
    }

    return target.shares === undefined
      ? { size: target.size, shares: sharesFor(current, target.needs, home), exactShares: false }
      : { size: target.size, shares: target.shares, exactShares: true };
  };

  const refused = (missing: string[], sessions: number, text: string, mounts: VmShare[]) =>
    new LauncherError(
      `${notShared(missing)}; ${sessionsRunning(sessions)}, and restarting the VM to ${text} would end them`,
      `end them and run pi again, or share it yourself with ${restartText(profile, { shares: mounts })}`,
    );

  const reconcileLocked = async (target: VmReconcile, options: VmShareOptions) => {
    if (target.shares !== undefined) {
      assertDesiredCovers(target.shares, target.needs);
    }

    const read = await shares.readShares();

    if (read === "unreadable") {
      options.report(UNREADABLE);
    }

    const current = Array.isArray(read) ? read : undefined;
    const wanted = launchWanted(target, current);
    const found: VmFound = {
      state: "running",
      size: Object.keys(target.size).length === 0 ? undefined : await size(),
      shares: current ?? "unreadable",
    };
    const decision = await decide(found, wanted, options.busy);

    if ("keptDiskGiB" in decision && decision.keptDiskGiB !== undefined) {
      options.report(shrinkNotice(target.size, decision.keptDiskGiB));
    }

    if (decision.kind !== "restart" && decision.kind !== "defer") {
      return;
    }

    const planned = restartOf(found, wanted, decision);
    const text = changeText(wanted, planned);

    if (decision.kind === "defer") {
      const missing = current === undefined ? [] : uncoveredPaths(current, target.needs);

      if (missing.length > 0) {
        throw refused(missing, decision.sessions, text, planned.mounts);
      }

      options.report(deferredUntilIdle(text));

      return;
    }

    options.report(`restarting the sandbox VM to ${text}`);

    await restart(wanted, planned, target.needs, () => undefined);
  };

  return {
    inspect,
    apply: (desired, options) => withLock(() => applyLocked(desired, options)),
    ensureRunning,
    coverage: shares.coverage,
    reconcile: (target, options) => withLock(() => reconcileLocked(target, options)),
    ensureTrust: trust.ensureTrust,
    size,
    resizeCommand: (size) => restartText(profile, { size }),
    stop,
  };
};
