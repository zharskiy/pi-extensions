import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type CommandRunner,
  errorMessage,
  LauncherError,
  parseJsonObject,
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
  VmReport,
  VmShare,
  VmShareOptions,
  VmSize,
  VmSpec,
  VmTarget,
} from "../types.ts";
import { hasSizeChanges, vmSizeDrift, vmSizeText } from "../vm-size.ts";
import { vmSharesOf, vmSizeOfYaml } from "./colima-yaml.ts";
import { type Colima, ENGINE_PROFILE, ENGINE_SOCKET_DISPLAY, logHint, plainStart } from "./profile.ts";
import { createColimaShares, shareDrift, startArgs } from "./shares.ts";
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

const MIN_CPUS = 2;

const MAX_CPUS = 8;

const MIN_GIB = 4;

const MAX_GIB = 10;

const GIB = 1024 ** 3;

const START_FAILURE = "could not start the sandbox VM";

const STOP_FAILURE = "could not stop the sandbox VM";

const RESIZE_FAILURE = "could not change the size of the sandbox VM";

const CREATE_FAILURE = "could not create the sandbox VM";

const RESTART_FAILURE = "could not restart the sandbox VM";

const INSPECT_TIMEOUT_MS = 3000;

const AUTOMATIC_DISK_GIB = 60;

const CREATE_FLAGS = ["--vm-type", "vz", "--mount-type", "virtiofs"];

const startHint = `run ${plainStart(ENGINE_PROFILE)} and see ${logHint(ENGINE_PROFILE)}`;

export const engineUnreachable = (detection?: Detection) =>
  new LauncherError(
    `the sandbox VM engine is unreachable at ${ENGINE_SOCKET_DISPLAY}${detection?.reason === undefined ? "" : `: ${detection.reason}`}`,
    `run launcher/install.sh or ${plainStart(ENGINE_PROFILE)}`,
  );

const engineSilent = (detection: Detection) =>
  new LauncherError(
    `the sandbox VM is running but its engine at ${ENGINE_SOCKET_DISPLAY} does not answer: ${detection.reason ?? "not detected"}`,
    `run colima stop --profile ${ENGINE_PROFILE} && ${plainStart(ENGINE_PROFILE)} and see ${logHint(ENGINE_PROFILE)}`,
  );

const lastLine = (text: string) => text.trim().split("\n").at(-1) ?? "";

const realPause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

export const recommendedVmSize = (cpus: number, memGiB: number): VmSpec => ({
  cpus: clamp(Math.floor(cpus), MIN_CPUS, MAX_CPUS),
  memoryGiB: clamp(Math.floor(memGiB / 2), MIN_GIB, MAX_GIB),
  diskGiB: AUTOMATIC_DISK_GIB,
});

const shrinkNotice = (target: VmTarget, keptDiskGiB: number) =>
  `vm.diskGiB ${target.diskGiB} is below the sandbox VM's disk of ${keptDiskGiB} GiB; colima cannot shrink a disk, so it stays`;

const sizeFlags = (target: VmTarget) => [
  ...(target.cpus === undefined ? [] : ["--cpu", String(target.cpus)]),
  ...(target.memoryGiB === undefined ? [] : ["--memory", String(target.memoryGiB)]),
  ...(target.diskGiB === undefined ? [] : ["--disk", String(target.diskGiB)]),
];

const plural = (count: number) =>
  count === 1 ? "1 pi session is running" : `${count} pi sessions are running`;

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

  const colima: Colima = { home, profile, run, detectAgain, withLock };
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

  const coldStartFlags = async (target: VmTarget, report: VmReport) => {
    const text = await readProfileYaml();
    const current = text === undefined ? undefined : vmSizeOfYaml(text);

    if (current === undefined) {
      return sizeFlags({ cpus: target.cpus, memoryGiB: target.memoryGiB });
    }

    const drift = vmSizeDrift(current, target);

    if (drift.keptDiskGiB !== undefined) {
      report(shrinkNotice(target, drift.keptDiskGiB));
    }

    return sizeFlags(drift.changes);
  };

  const running = async (failure: string) => {
    const result = await colimaRun(["status", "--profile", profile]).catch((error: unknown) => {
      throw new LauncherError(`${failure}: ${errorMessage(error)}`, "run launcher/install.sh");
    });

    return result.code === 0;
  };

  const startStopped = async (report: VmReport, shares: VmShare[], target: VmTarget) => {
    const flags = await coldStartFlags(target, report);

    report("starting the sandbox VM");

    await run(START_FAILURE, [...startArgs(profile, shares), ...flags], startHint);

    const detection = await detectAgain();

    if (detection?.available !== true) {
      throw new LauncherError(
        `the sandbox VM started but its engine is unreachable: ${detection?.reason ?? "not detected"}`,
        startHint,
      );
    }
  };

  const ensureUp = async (report: VmReport, shares: VmShare[], target: VmTarget) => {
    if ((await detect()).available) {
      return;
    }

    await withLock(async () => {
      const detection = await detect();

      if (detection.available) {
        return;
      }

      if (!(await profileExists())) {
        throw engineUnreachable();
      }

      if (await running(START_FAILURE)) {
        throw engineSilent(detection);
      }

      await startStopped(report, shares, target);
    });
  };

  const ensureRunning = async (report: VmReport, shares: VmShare[] = [], target: VmTarget = {}) => {
    await ensureUp(report, shares, target);

    trust.readEarly();
  };

  const refuseBusy = async (busy: VmShareOptions["busy"]) => {
    const count = await busy();

    if (count > 0) {
      throw new LauncherError(
        `${plural(count)}; stopping the sandbox VM would end them`,
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

  const restartSized = async (changes: VmTarget) => {
    await run(RESIZE_FAILURE, ["stop", "--profile", profile], `see ${logHint(profile)}`);

    await run(RESIZE_FAILURE, [...startArgs(profile, []), ...sizeFlags(changes)], startHint);

    const detection = await detectAgain();

    if (detection?.available !== true) {
      throw new LauncherError(
        `the sandbox VM did not come back after changing its size: ${detection?.reason ?? "not detected"}`,
        startHint,
      );
    }
  };

  const resizeDrifted = async (target: VmTarget, options: VmShareOptions) => {
    const current = await size();
    const drift = current === undefined ? undefined : vmSizeDrift(current, target);

    if (drift === undefined || !hasSizeChanges(drift)) {
      return;
    }

    const changes = vmSizeText(drift.changes);

    if ((await options.busy()) > 0) {
      options.report(
        `the sandbox VM keeps its size while other pi sessions run; it changes to ${changes} at the next launch with no pi session running`,
      );

      return;
    }

    options.report(`restarting the sandbox VM to change its size to ${changes}`);

    await restartSized(drift.changes);
  };

  const ensureSize: Vm["ensureSize"] = async (target, options) => {
    const current = Object.keys(target).length === 0 ? undefined : await size();
    const drift = current === undefined ? undefined : vmSizeDrift(current, target);

    if (drift?.keptDiskGiB !== undefined) {
      options.report(shrinkNotice(target, drift.keptDiskGiB));
    }

    if (drift === undefined || !hasSizeChanges(drift)) {
      return;
    }

    await withLock(() => resizeDrifted(target, options));
  };

  const statusSize = async (): Promise<VmSize | undefined> => {
    const result = await colimaRun(["status", "--profile", profile, "--json"], {
      timeoutMs: INSPECT_TIMEOUT_MS,
    });

    if (result.timedOut === true) {
      throw new LauncherError(`colima did not answer within ${INSPECT_TIMEOUT_MS / 1000} seconds`);
    }

    const vm = result.code === 0 ? parseJsonObject(result.stdout) : undefined;

    if (typeof vm?.cpu !== "number" || typeof vm.memory !== "number") {
      return undefined;
    }

    const measured = { cpus: vm.cpu, memoryGiB: vm.memory / GIB };

    return typeof vm.disk === "number" ? { ...measured, diskGiB: vm.disk / GIB } : measured;
  };

  const size = () => statusSize().catch(() => undefined);

  const completeSize = (measured: VmSize | undefined, configured: VmSize | undefined): VmSpec => {
    const diskGiB = measured?.diskGiB ?? configured?.diskGiB;
    const known = measured ?? configured;

    if (known === undefined || diskGiB === undefined) {
      throw new LauncherError(`colima reported no size for profile ${profile}`);
    }

    return { cpus: known.cpus, memoryGiB: Math.round(known.memoryGiB), diskGiB: Math.round(diskGiB) };
  };

  const inspect = async (): Promise<VmInspect> => {
    const text = await readProfileYaml();

    if (text === undefined) {
      return { state: "absent" };
    }

    const measured = await statusSize();
    const configured = vmSizeOfYaml(text);

    if (measured === undefined) {
      return {
        state: "stopped",
        size: completeSize(undefined, configured),
        shares: vmSharesOf(text, home) ?? "unreadable",
      };
    }

    return {
      state: "running",
      size: completeSize(measured, configured),
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
      [...startArgs(profile, desired.shares), ...CREATE_FLAGS, ...sizeFlags(desired.size)],
      startHint,
    );

    await waitForEngine("creating it", progress);
  };

  const restartedShares = (current: VmShare[] | "unreadable", desired: VmDesired) =>
    desired.exactShares || current === "unreadable"
      ? desired.shares
      : [...current, ...shareDrift(current, desired.shares).lacking];

  const sharesDiffer = (current: VmShare[] | "unreadable", desired: VmDesired) => {
    if (current === "unreadable") {
      return true;
    }

    const drift = shareDrift(current, desired.shares);

    return drift.lacking.length > 0 || (desired.exactShares && drift.extra.length > 0);
  };

  const applyLocked = async (desired: VmDesired, options: VmApplyOptions): Promise<VmApplied> => {
    const found = await inspect();

    if (found.state === "absent") {
      await create(desired, options.progress);

      return "created";
    }

    if (found.state === "stopped") {
      return "stopped";
    }

    const drift = vmSizeDrift(found.size, desired.size);

    if (!hasSizeChanges(drift) && !sharesDiffer(found.shares, desired)) {
      return "unchanged";
    }

    const count = await options.busy();

    if (count > 0) {
      return { deferred: count };
    }

    options.progress("stopping");

    await run(RESTART_FAILURE, ["stop", "--profile", profile], `see ${logHint(profile)}`);

    options.progress("starting");

    await run(
      RESTART_FAILURE,
      [...startArgs(profile, restartedShares(found.shares, desired)), ...sizeFlags(drift.changes)],
      startHint,
    );

    await waitForEngine("restarting it", options.progress);

    return "restarted";
  };

  return {
    inspect,
    apply: (desired, options) => withLock(() => applyLocked(desired, options)),
    ensureRunning,
    coverage: shares.coverage,
    ensureShares: shares.ensureShares,
    reconcileShares: shares.reconcileShares,
    ensureTrust: trust.ensureTrust,
    ensureSize,
    size,
    resizeCommand: (target) =>
      `colima stop --profile ${profile} && ${[plainStart(profile), ...sizeFlags(target)].join(" ")}`,
    stop,
  };
};
