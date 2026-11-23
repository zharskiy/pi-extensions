import { constants } from "node:os";
import { type Backend, GUEST_PROXY_HOST, GUEST_PROXY_PORT, type VmWatch } from "../backend/index.ts";
import { guestPathOf, type SandboxConfig, writeBackTableOf } from "../config/index.ts";
import {
  buildContainerSpec,
  configVolumes,
  forwardedEnv,
  forwardedNames,
  type LauncherContainerSpec,
  runPi,
  startLaunchContainer,
} from "../container/index.ts";
import type { Launch } from "../grants/index.ts";
import { type HostPiFiles, readHostPiFiles } from "../hostpi/index.ts";
import { ensureSandboxImage, type SandboxImage } from "../image/index.ts";
import {
  installPackages,
  isPiOffline,
  type PackageChanges,
  renderAgentDir,
  type SandboxStatusInput,
  syncVolumeFiles,
} from "../provision/index.ts";
import { type DenialRecord, preambleText } from "../proxy/index.ts";
import { errorMessage, settleAll, stateLayout, type WriteBackTable } from "../shared/index.ts";
import { confirmBinds, type HostBind, type HostSessions, hostBinds } from "../workspace/index.ts";
import { busyLaunches } from "./busy.ts";
import { hostClipboard } from "./clipboard.ts";
import { checkHostRoot, type LaunchContext, openContext } from "./context.ts";
import { type CliDeps, hostAgentDirOf, writeLine, writeNotices } from "./deps.ts";
import { type HostSide, type PreparedHost, prepareHostSide } from "./derive.ts";
import { startServices, withGroundLock } from "./ground.ts";
import { NO_SANDBOX, resolveJobPi, runHostPi } from "./host-pi.ts";
import {
  hostSessionsOf,
  noticeHostSessions,
  probeSessionsShare,
  readyHostSessions,
} from "./host-sessions.ts";
import { hostPathNotices, launchNotices, proxyDetail } from "./launch-notices.ts";
import { beginLaunch, finishLaunch } from "./launches.ts";
import { signInMcpServers } from "./mcp-sign-in.ts";
import { writeOnce } from "./notices.ts";
import { runSetup, withAgentLock, withPrepareLock } from "./prepare.ts";
import { openSandboxProxy, reportDenials, type SandboxProxy, sandboxDenials } from "./sandbox-proxy.ts";
import { sweepOrphans } from "./sweep.ts";
import { imagePiVersion } from "./versions.ts";
import {
  assertMemoryFitsVm,
  assertVmFitsHost,
  prepareVmShares,
  reconcileVm,
  rootPaths,
  startVm,
  trustVm,
  vmTargetOf,
  writableMounts,
} from "./vm.ts";

interface PreparedContainer {
  containerId: string;
  spec: LauncherContainerSpec;
  image: SandboxImage;
}

interface ForwardedEnv {
  env: Record<string, string>;
  notices: string[];
}

export interface Sandbox extends PreparedContainer {
  backend: Backend;
  host: HostSide;
  proxy: SandboxProxy;
  launch: Launch;
  forwarded: ForwardedEnv;
}

export type Stage = "vm" | "shares" | "host" | "proxy" | "image" | "container" | "sync";

export type StageOutcome = { ok: true; detail?: string } | { ok: false; error: unknown };

type StageReport = (stage: Stage, outcome: StageOutcome) => void;

type Progress = (line: string) => void;

interface SandboxOptions {
  report?: StageReport;
  progress?: Progress;
  signIn?: boolean;
  share?: boolean;
  denials?: (records: DenialRecord[]) => void;
  writeBack?: boolean;
  probe?: boolean;
  piArgs?: string[];
}

type Staged = <T>(stage: Stage, action: () => Promise<T>, detail?: (value: T) => string) => Promise<T>;

interface SandboxInput {
  deps: CliDeps;
  context: LaunchContext;
  backend: Backend;
  launch: Launch;
  sessions: HostSessions;
  cancelled: AbortSignal;
  staged: Staged;
  progress: Progress;
  writeBack: boolean;
  allowlist: WriteBackTable;
  binds: HostBind[];
  probe: boolean;
  forwarded: ForwardedEnv;
  piArgs: string[];
}

interface PreparedInput extends SandboxInput {
  prepared: PreparedHost;
  othersLive: () => Promise<boolean>;
}

const PREPARING = "preparing pi sandbox, one time";

const STOPPING = "pi-sandbox: stopping after the current step";

const SKIPPING_WAITS =
  "pi-sandbox: the cleanup will not wait for other pi-sandbox commands; another Ctrl-C ends pi-sandbox at once, leaving the rest to the next start";

const PREPARATION_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

const SIGNAL_EXIT_BASE = 128;

const stagedWith =
  (report: StageReport): Staged =>
  async (stage, action, detail) => {
    try {
      const value = await action();

      report(stage, { ok: true, detail: detail?.(value) });

      return value;
    } catch (error) {
      report(stage, { ok: false, error });

      throw error;
    }
  };

const handled = <T>(pending: Promise<T>) => {
  pending.catch(() => undefined);

  return pending;
};

const startHostSide = (deps: CliDeps, context: LaunchContext, files: HostPiFiles) =>
  handled(resolveJobPi(deps).then((pi) => prepareHostSide(deps, context, files, pi)));

const prepareHost = async (
  deps: CliDeps,
  context: LaunchContext,
  backend: Backend,
  parts: { deriving: Promise<PreparedHost>; sessions: HostSessions; signIn: boolean },
) => {
  const [prepared] = await settleAll([parts.deriving, sweepOrphans(deps, backend)]);

  writeNotices(deps, prepared.notices);

  noticeHostSessions(deps, parts.sessions);

  if (parts.signIn) {
    await signInMcpServers(deps, context, prepared.host);
  }

  return prepared;
};

const prepareImage = (
  deps: CliDeps,
  context: LaunchContext,
  backend: Backend,
  parts: { host: HostSide; progress: Progress },
): Promise<SandboxImage> =>
  ensureSandboxImage({
    backend,
    config: context.effective.config,
    stateDir: context.stateDir,
    env: deps.env,
    trustPem: parts.host.trust.extraPemPath,
    proxyCaPem: parts.host.trust.caCertPath,
    versions: async () => ({ pi: await imagePiVersion(parts.host.pi) }),
    preparing: () => parts.progress(PREPARING),
    waiting: () => parts.progress("pi-sandbox: waiting for the image build in another session"),
    progress: (step) => parts.progress(`pi-sandbox: build: ${step}`),
  });

const sandboxRoute = async (input: PreparedInput, proxy: SandboxProxy, imageId: string) => {
  const lock = { stateDir: input.context.stateDir, signal: input.cancelled, progress: input.progress };
  const name = await withGroundLock(lock, () =>
    input.backend.prepareRelay({
      hostPort: proxy.proxy.port,
      imageId,
      preamble: preambleText(proxy.token),
    }),
  );

  return {
    url: `http://${GUEST_PROXY_HOST}:${GUEST_PROXY_PORT}`,
    network: { kind: "internal" as const, name },
  };
};

interface VolumeSync {
  containerId: string;
  hostAgentDir: string;
  writeBack: boolean;
  allowlist: WriteBackTable;
  refreshPackages?: boolean;
  othersLive?: () => Promise<boolean>;
}

const syncVolume = async (deps: CliDeps, context: LaunchContext, backend: Backend, sync: VolumeSync) => {
  const { changes, notices, packages } = await syncVolumeFiles({
    backend,
    stateDir: context.stateDir,
    workspaceRoot: context.mountedRoot,
    hostHome: deps.home,
    ...sync,
  });

  writeNotices(deps, [...changes, ...notices]);

  return packages;
};

const syncAgentFiles = (input: PreparedInput, containerId: string) =>
  syncVolume(input.deps, input.context, input.backend, {
    containerId,
    hostAgentDir: input.prepared.host.hostAgentDir,
    writeBack: input.writeBack,
    allowlist: input.allowlist,
    refreshPackages: true,
    othersLive: input.othersLive,
  });

const agentLockOf = (input: PreparedInput) => ({
  stateDir: input.context.stateDir,
  signal: input.cancelled,
  progress: input.progress,
});

const installAgentPackages = async (
  input: PreparedInput,
  container: PreparedContainer,
  packages: PackageChanges | undefined,
) => {
  if (input.probe) {
    return;
  }

  const env = input.forwarded.env;
  const notices = await installPackages({
    backend: input.backend,
    containerId: container.containerId,
    env,
    packages,
    failedPath: stateLayout(input.context.stateDir).sync.installFailed,
    offline: isPiOffline({ ...container.spec.env, ...env }, input.piArgs),
    announce: (notice) => writeNotices(input.deps, [notice]),
  });

  writeNotices(input.deps, notices);
};

const prepareAgentFolder = (input: PreparedInput, container: PreparedContainer) =>
  withAgentLock(agentLockOf(input), async () => {
    const packages = await syncAgentFiles(input, container.containerId);

    await installAgentPackages(input, container, packages);
  });

const statusInput = (config: SandboxConfig): SandboxStatusInput => {
  const { cpus, memoryGiB, pids, openFiles, shmMiB } = config.resources;

  return {
    resources: { cpus, memoryGiB, pids, openFiles, shmMiB },
    volumes: configVolumes(config).map((volume) => volume.target),
    binds: config.mounts.binds.map((entry) => guestPathOf(entry.target)),
    setup: config.setup,
    services: config.services.map((service) => ({
      name: service.name,
      command: service.command,
      ready: service.ready?.command,
      ports: service.ports ?? [],
    })),
  };
};

const prepareFiles = async (input: PreparedInput) => {
  const { deps, context, backend, launch, sessions } = input;
  const { host } = input.prepared;
  const [render] = await settleAll([
    renderAgentDir({
      stateDir: context.stateDir,
      hostAgentDir: host.hostAgentDir,
      hostHome: deps.home,
      derived: host.derived,
      status: statusInput(context.effective.config),
    }),
    readyHostSessions(deps, context, backend, { sessions, launchId: launch.launchId }),
  ]);

  return { render };
};

type PreparedFiles = Awaited<ReturnType<typeof prepareFiles>>;

type Route = Awaited<ReturnType<typeof sandboxRoute>>;

const prepareServices = (input: PreparedInput, image: SandboxImage) => {
  const { context } = input;

  if (input.probe) {
    return Promise.resolve();
  }

  return startServices({
    backend: input.backend,
    stateDir: context.stateDir,
    launchId: input.launch.launchId,
    services: context.effective.config.services,
    image: image.id,
    report: input.progress,
    signal: input.cancelled,
  });
};

const servicePortsOf = (input: PreparedInput) =>
  input.probe ? [] : input.context.effective.config.services.flatMap((service) => service.ports ?? []);

const prepareContainer = async (
  input: PreparedInput,
  parts: {
    image: SandboxImage;
    files: PreparedFiles;
    route: Route;
  },
): Promise<PreparedContainer> => {
  const { deps, context, backend, launch, sessions, cancelled } = input;
  const { host } = input.prepared;
  const { image, route } = parts;
  const { render } = parts.files;

  await writeOnce(deps, context.stateDir, [
    ...render.notices.map((notice) => `pi-sandbox: ${notice}`),
    ...launchNotices(context),
  ]);

  cancelled.throwIfAborted();

  const built = buildContainerSpec({
    workspace: context.workspace,
    config: context.effective.config,
    image,
    stateDir: context.stateDir,
    launchId: launch.launchId,
    workspaceRoot: context.mountedRoot,
    proxy: route,
    servicePorts: servicePortsOf(input),
    renderDir: render.renderDir,
    hostSessions: sessions,
    toolEnv: host.derived.tools.env,
    binds: input.binds.map((entry) => ({ source: entry.source, target: guestPathOf(entry.target) })),
  });

  confirmBinds(input.binds);

  const { id, spec, notices } = await withAgentLock(agentLockOf(input), () =>
    startLaunchContainer({
      backend,
      stateDir: context.stateDir,
      spec: built,
      afterCreate: (created) => probeSessionsShare(backend, created, sessions),
      pinnedImage: context.effective.config.image.digest !== undefined,
    }),
  );

  writeNotices(deps, [
    ...notices,
    ...(await hostPathNotices(input.piArgs, context.workspace.cwd, spec.mounts)),
  ]);

  return { containerId: id, spec, image };
};

const forwardedOf = (deps: CliDeps, context: LaunchContext): ForwardedEnv => {
  const notices: string[] = [];
  const env = forwardedEnv(forwardedNames(context.effective.config.env), deps.env, (notice) => {
    notices.push(notice);
  });

  return { env, notices };
};

const setupContainer = (input: PreparedInput, containerId: string) => {
  const { deps, context, backend, launch, cancelled, progress } = input;

  if (input.probe) {
    return Promise.resolve();
  }

  return runSetup({
    backend,
    containerId,
    commands: context.effective.config.setup,
    env: { ...input.forwarded.env, PI_SANDBOX_LAUNCH_ID: launch.launchId },
    workdir: context.workspace.repoRoot,
    stdout: deps.stdout,
    stderr: deps.stderr,
    signal: cancelled,
    progress,
  });
};

const prepareSandbox = async (input: PreparedInput) => {
  const { deps, context, backend, launch, cancelled, staged, progress } = input;
  const { host } = input.prepared;
  const pending = [
    openSandboxProxy(deps, context, host, { launch, progress, signal: cancelled }),
    prepareImage(deps, context, backend, { host, progress }),
  ] as const;
  const files = handled(prepareFiles(input));

  await Promise.allSettled([...pending, files]);

  const [proxy, image] = await settleAll([
    staged("proxy", () => pending[0], proxyDetail),
    staged(
      "image",
      () => pending[1],
      (ready) => `${ready.reference} ${ready.digest}`,
    ),
  ]);

  cancelled.throwIfAborted();

  const prepared = await withPrepareLock(
    { stateDir: context.stateDir, repoHash: context.repoHash, signal: cancelled, progress },
    async () => {
      const container = await staged("container", async () => {
        const [settled, route] = await settleAll([files, sandboxRoute(input, proxy, image.id)]);

        await prepareServices(input, image);

        return prepareContainer(input, { image, files: settled, route });
      });

      cancelled.throwIfAborted();

      await setupContainer(input, container.containerId);

      return container;
    },
  );

  cancelled.throwIfAborted();

  await staged("sync", () => prepareAgentFolder(input, prepared)).catch((error: unknown) => {
    writeLine(deps.stderr, `pi-sandbox: warning: the agent settings were not synced: ${errorMessage(error)}`);
  });

  return { prepared, proxy };
};

const firstSignal = (deps: CliDeps) => {
  const source = deps.signals ?? process;
  const listeners = new Map<NodeJS.Signals, () => void>();
  const stop = () => {
    listeners.forEach((listener, name) => {
      source.off(name, listener);
    });

    listeners.clear();
  };
  const received = new Promise<NodeJS.Signals>((resolve) => {
    PREPARATION_SIGNALS.forEach((name) => {
      const listener = () => {
        stop();

        writeLine(deps.stderr, STOPPING);

        resolve(name);
      };

      listeners.set(name, listener);

      source.on(name, listener);
    });
  });

  return { received, stop };
};

const shielded = async <T>(deps: CliDeps, action: (signal: AbortSignal) => Promise<T>) => {
  const source = deps.signals ?? process;
  const skip = new AbortController();
  const unlisten = () => {
    PREPARATION_SIGNALS.forEach((name) => {
      source.off(name, skipWaits);
    });
  };
  const skipWaits = () => {
    skip.abort();

    unlisten();

    writeLine(deps.stderr, SKIPPING_WAITS);
  };

  PREPARATION_SIGNALS.forEach((name) => {
    source.on(name, skipWaits);
  });

  try {
    return await action(skip.signal);
  } finally {
    unlisten();
  }
};

const prepareVm = async (input: SandboxInput, share: boolean) => {
  const { deps, context, backend, sessions, launch, staged, progress } = input;

  const size = vmTargetOf(context.effective.config.vm);

  assertVmFitsHost(deps, size);

  assertMemoryFitsVm(deps, context.effective.config);

  const planShares = () => prepareVmShares(deps, context.effective.config.workspaceRoot, input.binds);

  if (!share) {
    await staged("vm", async () => startVm(backend, sessions, progress, { plan: await planShares(), size }));

    return;
  }

  const plan = await planShares();

  await staged("vm", () => startVm(backend, sessions, progress, { plan, size }));

  await staged("shares", () =>
    reconcileVm(deps, context, backend, { sessions, launchId: launch.launchId, plan, binds: input.binds }),
  );
};

const prepareAll = async (
  input: SandboxInput,
  parts: { deriving: Promise<PreparedHost>; signIn: boolean; share: boolean },
) => {
  const { deps, context, backend, sessions, cancelled, staged } = input;
  const { deriving, signIn } = parts;

  try {
    await prepareVm(input, parts.share);
  } catch (error) {
    await deriving.catch(() => undefined);

    throw error;
  }

  cancelled.throwIfAborted();

  const prepared = await staged("host", () =>
    prepareHost(deps, context, backend, { deriving, sessions, signIn }),
  );

  await trustVm(deps, context, backend, {
    extraPemPath: prepared.host.trust.extraPemPath,
    launchId: input.launch.launchId,
  });

  cancelled.throwIfAborted();

  return {
    host: prepared.host,
    ...(await prepareSandbox({
      ...input,
      prepared,
      othersLive: async () => (await busyLaunches(context.stateDir, input.launch.launchId)) > 0,
    })),
  };
};

export const withSandbox = async (
  deps: CliDeps,
  context: LaunchContext,
  backend: Backend,
  use: (sandbox: Sandbox) => Promise<number>,
  {
    report = () => undefined,
    progress = (line) => writeLine(deps.stderr, line),
    signIn = true,
    share = true,
    denials = reportDenials(deps),
    writeBack = false,
    probe = false,
    piArgs = [],
  }: SandboxOptions = {},
) => {
  const files = await readHostPiFiles(hostAgentDirOf(deps));
  const sessions = hostSessionsOf(deps, context, files.settings);
  const binds = probe
    ? []
    : hostBinds(context.effective.config.mounts.binds, {
        home: deps.home,
        env: deps.env,
        roots: [...writableMounts(context, sessions), ...rootPaths(context.effective.config)],
      });
  const forwarded = forwardedOf(deps, context);
  const staged = stagedWith(report);
  const launch = await beginLaunch(deps, context, progress);
  const ended: {
    signal?: ReturnType<typeof firstSignal>;
    unwinding?: Promise<unknown>;
    proxy?: SandboxProxy;
    sync?: VolumeSync;
    watch?: VmWatch;
  } = {};

  try {
    const signal = firstSignal(deps);

    ended.signal = signal;

    const cancel = new AbortController();
    const deriving = startHostSide(deps, context, files);
    const allowlist = writeBackTableOf(context.effective.config.writeBack);
    const preparation = prepareAll(
      {
        deps,
        context,
        backend,
        launch,
        sessions,
        cancelled: cancel.signal,
        staged,
        progress,
        writeBack,
        allowlist,
        binds,
        probe,
        forwarded,
        piArgs,
      },
      { deriving, signIn, share },
    );
    const outcome = await Promise.race([
      preparation.then((ready) => ({ ready })),
      signal.received.then((name) => ({ name })),
    ]);

    if ("name" in outcome) {
      cancel.abort();

      ended.unwinding = preparation.catch(() => undefined);

      return SIGNAL_EXIT_BASE + constants.signals[outcome.name];
    }

    signal.stop();

    const { prepared, proxy, host } = outcome.ready;

    ended.proxy = proxy;
    ended.sync = { containerId: prepared.containerId, hostAgentDir: host.hostAgentDir, writeBack, allowlist };
    ended.watch =
      !probe && context.effective.config.vm.releaseFileCache ? backend.vm.watchFileCache?.() : undefined;

    return await use({ ...prepared, backend, host, proxy, launch, forwarded });
  } finally {
    ended.signal?.stop();

    await shielded(deps, async (skipWaits) => {
      await ended.watch?.stop();

      await ended.unwinding;

      if (ended.proxy !== undefined) {
        denials(await sandboxDenials(deps, context, launch.startedAt));
      }

      const sync = ended.sync;

      if (sync?.writeBack === true) {
        const lock = { stateDir: context.stateDir, signal: skipWaits, progress };

        await withAgentLock(lock, () => syncVolume(deps, context, backend, sync)).catch((error: unknown) => {
          writeLine(
            deps.stderr,
            `pi-sandbox: warning: settings were not written back: ${errorMessage(error)}`,
          );
        });
      }

      await finishLaunch(deps, context, backend, launch, skipWaits);
    });
  }
};

const startPi = (deps: CliDeps, context: LaunchContext, sandbox: Sandbox, piArgs: string[]) => {
  writeNotices(deps, sandbox.forwarded.notices);

  return runPi({
    backend: sandbox.backend,
    containerId: sandbox.containerId,
    piArgs,
    env: sandbox.forwarded.env,
    launchId: sandbox.launch.launchId,
    workspace: context.workspace,
    terminal: deps.terminal,
    signals: deps.signals,
    clipboard: hostClipboard(deps, context, sandbox.spec.mounts),
  });
};

export const launch = async (args: string[], deps: CliDeps) => {
  const piArgs = args.filter((arg) => arg !== NO_SANDBOX);

  if (piArgs.length !== args.length) {
    const { context } = await openContext(deps, "host");

    checkHostRoot(deps, context);

    return runHostPi(deps, context, piArgs);
  }

  const { context, backend } = await openContext(deps, "sandbox");

  return withSandbox(deps, context, backend, (sandbox) => startPi(deps, context, sandbox, piArgs), {
    writeBack: true,
    piArgs,
  });
};
