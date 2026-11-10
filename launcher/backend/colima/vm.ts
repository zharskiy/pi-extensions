import { access } from "node:fs/promises";
import { join } from "node:path";
import {
  type CommandRunner,
  errorMessage,
  LauncherError,
  parseJsonObject,
  stateLayout,
  withDirectoryLock,
} from "../../shared/index.ts";
import type { Detection, Vm, VmPath, VmReport, VmShareOptions, VmSize } from "../types.ts";
import { type Colima, ENGINE_PROFILE, ENGINE_SOCKET_DISPLAY, logHint, plainStart } from "./profile.ts";
import { createColimaShares } from "./shares.ts";

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

const startHint = `run ${plainStart(ENGINE_PROFILE)} and see ${logHint(ENGINE_PROFILE)}`;

export const engineUnreachable = () =>
  new LauncherError(
    `the sandbox VM engine is unreachable at ${ENGINE_SOCKET_DISPLAY}`,
    `run launcher/install.sh or ${plainStart(ENGINE_PROFILE)}`,
  );

const lastLine = (text: string) => text.trim().split("\n").at(-1) ?? "";

const realPause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

export const recommendedVmSize = (cpus: number, memGiB: number): VmSize => ({
  cpus: clamp(Math.floor(cpus), MIN_CPUS, MAX_CPUS),
  memoryGiB: clamp(Math.floor(memGiB / 2), MIN_GIB, MAX_GIB),
});

const plural = (count: number) =>
  count === 1 ? "1 pi session is running" : `${count} pi sessions are running`;

export const createColimaVm = (options: ColimaVmOptions): Vm => {
  const { home, runner, detect, pause = realPause } = options;
  const profile = ENGINE_PROFILE;

  const run = async (failure: string, args: string[], hint: string) => {
    const result = await runner.run("colima", args).catch((error: unknown) => {
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

  const detectAgain = () =>
    DETECT_DELAYS_MS.reduce<Promise<Detection | undefined>>(async (previous, delay) => {
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

  const profileExists = () =>
    access(join(home, ".colima", profile, "colima.yaml")).then(
      () => true,
      () => false,
    );

  const running = async (failure: string) => {
    const result = await runner.run("colima", ["status", "--profile", profile]).catch((error: unknown) => {
      throw new LauncherError(`${failure}: ${errorMessage(error)}`, "run launcher/install.sh");
    });

    return result.code === 0;
  };

  const startStopped = async (report: VmReport, needs: VmPath[] | undefined) => {
    const sharing = needs === undefined ? undefined : await shares.planStart(needs);

    report(
      sharing === undefined
        ? "starting the sandbox VM"
        : `starting the sandbox VM, sharing ${sharing.shared} with it, one time`,
    );

    await run(START_FAILURE, sharing?.args ?? ["start", "--profile", profile, "--activate=false"], startHint);

    await sharing?.verify();

    const detection = await detectAgain();

    if (detection?.available !== true) {
      throw new LauncherError(
        `the sandbox VM started but its engine is unreachable: ${detection?.reason ?? "not detected"}`,
        startHint,
      );
    }
  };

  const ensureRunning = async (report: VmReport, needs?: VmPath[]) => {
    if ((await detect()).available) {
      return;
    }

    await withLock(async () => {
      if ((await detect()).available) {
        return;
      }

      if (!(await profileExists()) || (await running(START_FAILURE))) {
        throw engineUnreachable();
      }

      await startStopped(report, needs);
    });
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

  const size = async (): Promise<VmSize | undefined> => {
    const result = await runner
      .run("colima", ["status", "--profile", profile, "--json"])
      .catch(() => undefined);
    const vm = result?.code === 0 ? parseJsonObject(result.stdout) : undefined;

    return typeof vm?.cpu === "number" && typeof vm.memory === "number"
      ? { cpus: vm.cpu, memoryGiB: vm.memory / GIB }
      : undefined;
  };

  return {
    ensureRunning,
    coverage: shares.coverage,
    ensureShares: shares.ensureShares,
    size,
    resizeCommand: (target) =>
      `colima stop --profile ${profile} && ${plainStart(profile)} --cpu ${target.cpus} --memory ${target.memoryGiB}`,
    stop,
  };
};
