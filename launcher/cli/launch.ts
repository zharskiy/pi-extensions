import { constants } from "node:os";
import type { Backend } from "../backend/index.ts";
import {
  buildContainerSpec,
  forwardedEnv,
  type GitOverlay,
  type LauncherContainerSpec,
  planGitOverlay,
  runPi,
  startLaunchContainer,
} from "../container/index.ts";
import { type Launch, othersLive, withRepoLaunchLock } from "../grants/index.ts";
import { type HostPiFiles, readHostPiFiles } from "../hostpi/index.ts";
import { ensureSandboxImage, type SandboxImage } from "../image/index.ts";
import { renderAgentDir, syncVolumeFiles } from "../provision/index.ts";
import { type DenialRecord, guestProxyUrl } from "../proxy/index.ts";
import { errorMessage, settleAll } from "../shared/index.ts";
import { gitLaunchNotices, type HostSessions } from "../workspace/index.ts";
import { checkWorkspaceRoots, type LaunchContext, openContext } from "./context.ts";
import { type CliDeps, hostAgentDirOf, writeLine, writeNotices } from "./deps.ts";
import { type HostSide, type PreparedHost, prepareHostSide } from "./derive.ts";
import { NO_SANDBOX, resolveJobPi, runHostPi } from "./host-pi.ts";
import {
  hostSessionsOf,
  noticeHostSessions,
  probeSessionsShare,
  readyHostSessions,
} from "./host-sessions.ts";
import { hostPathNotices, launchNotices, proxyDetail } from "./launch-notices.ts";
import { beginLaunch, finishLaunch, gitGuardOf } from "./launches.ts";
import { legacyNotices } from "./legacy-paths.ts";
import { signInMcpServers } from "./mcp-sign-in.ts";
import { writeOnce } from "./notices.ts";
import { openSandboxProxy, reportDenials, type SandboxProxy, sandboxDenials } from "./sandbox-proxy.ts";
import { sweepOrphans } from "./sweep.ts";
import { imagePiVersion } from "./versions.ts";
import { prepareVmShares, shareVm, startVm, trustVm } from "./vm.ts";

interface PreparedContainer {
  containerId: string;
  spec: LauncherContainerSpec;
  image: SandboxImage;
}

export interface Sandbox extends PreparedContainer {
  backend: Backend;
  host: HostSide;
  proxy: SandboxProxy;
  launch: Launch;
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
}

interface PreparedInput extends SandboxInput {
  prepared: PreparedHost;
}

const PREPARING = "preparing pi sandbox, one time";

const STOPPING = "pi-sandbox: stopping after the current step";

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

const startHostSide = (deps: CliDeps, context: LaunchContext, files: HostPiFiles, launchId: string) =>
  handled(resolveJobPi(deps).then((pi) => prepareHostSide(deps, context, files, { pi, launchId })));

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

const sandboxRoute = async (
  backend: Backend,
  proxy: SandboxProxy,
  imageId: string,
  context: LaunchContext,
) => {
  const { stateDir, repoHash } = context;
  const route = await withRepoLaunchLock(stateDir, repoHash, () =>
    backend.prepareProxyRoute({ hostPort: proxy.proxy.port, repoHash, imageId }),
  );

  return { url: guestProxyUrl(route, proxy.token), network: route.network };
};

interface VolumeSync {
  containerId: string;
  hostAgentDir: string;
  writeBack: boolean;
  refreshPackages?: boolean;
  othersLive?: () => Promise<boolean>;
}

const syncVolume = async (deps: CliDeps, context: LaunchContext, backend: Backend, sync: VolumeSync) => {
  const { changes, notices } = await syncVolumeFiles({
    backend,
    stateDir: context.stateDir,
    repoHash: context.repoHash,
    repoRoot: context.workspace.repoRoot,
    ...sync,
  });

  writeNotices(deps, [...changes, ...notices]);
};

const syncAgentFiles = (input: PreparedInput, containerId: string) =>
  syncVolume(input.deps, input.context, input.backend, {
    containerId,
    hostAgentDir: input.prepared.host.hostAgentDir,
    writeBack: input.writeBack,
    refreshPackages: true,
    othersLive: () => othersLive(input.context.stateDir, input.context.repoHash, input.launch.launchId),
  });

const prepareGround = async (input: PreparedInput) => {
  const { deps, context, backend, launch, sessions } = input;
  const { host } = input.prepared;
  const [render, gitNotices, git] = await settleAll([
    renderAgentDir({
      stateDir: context.stateDir,
      repoHash: context.repoHash,
      hostAgentDir: host.hostAgentDir,
      derived: host.derived,
      othersLive: () => othersLive(context.stateDir, context.repoHash, launch.launchId),
    }),
    gitLaunchNotices(context.workspace),
    planGitOverlay(context.workspace, gitGuardOf(deps, context)),
    readyHostSessions(deps, context, backend, { sessions, launchId: launch.launchId }),
  ]);

  return { render, gitNotices, git };
};

type Ground = Awaited<ReturnType<typeof prepareGround>>;

const prepareContainer = async (
  input: PreparedInput,
  parts: { proxy: SandboxProxy; image: SandboxImage; ground: Promise<Ground> },
): Promise<PreparedContainer> => {
  const { deps, context, backend, launch, sessions, cancelled } = input;
  const { host } = input.prepared;
  const { proxy, image } = parts;
  const [ground, route] = await settleAll([parts.ground, sandboxRoute(backend, proxy, image.id, context)]);
  const { render, gitNotices, git } = ground;

  writeNotices(deps, gitNotices);

  await writeOnce(deps, context, [
    ...render.notices.map((notice) => `pi-sandbox: ${notice}`),
    ...launchNotices(context),
  ]);

  const specWith = (gitOverlay: GitOverlay) =>
    buildContainerSpec({
      workspace: context.workspace,
      config: context.effective.config,
      image,
      hostUid: deps.uid,
      stateDir: context.stateDir,
      launchId: launch.launchId,
      gitOverlay,
      proxy: route,
      trust: host.trust,
      renderDir: render.renderDir,
      hostSessions: sessions,
      toolEnv: host.derived.tools.env,
    });
  const planned = specWith(git.overlay);

  cancelled.throwIfAborted();

  const { id, spec, notices } = await startLaunchContainer({
    backend,
    spec: planned,
    stateDir: context.stateDir,
    beforeStart: async () =>
      specWith(
        await git.ready({
          othersLive: await othersLive(context.stateDir, context.repoHash, launch.launchId),
        }),
      ),
    afterCreate: (created) => probeSessionsShare(backend, created, sessions),
  });

  writeNotices(deps, [...notices, ...git.pendingNotices()]);

  return { containerId: id, spec, image };
};

const prepareSandbox = async (input: PreparedInput) => {
  const { deps, context, backend, launch, cancelled, staged, progress } = input;
  const { host } = input.prepared;
  const pending = [
    openSandboxProxy(deps, context, host, launch),
    prepareImage(deps, context, backend, { host, progress }),
  ] as const;
  const ground = handled(prepareGround(input));

  await Promise.allSettled([...pending, ground]);

  const [proxy, image] = await settleAll([
    staged("proxy", () => pending[0], proxyDetail),
    staged(
      "image",
      () => pending[1],
      (ready) => `${ready.reference} ${ready.digest}`,
    ),
  ]);

  cancelled.throwIfAborted();

  const prepared = await staged("container", () => prepareContainer(input, { proxy, image, ground }));

  cancelled.throwIfAborted();

  await staged("sync", () => syncAgentFiles(input, prepared.containerId)).catch((error: unknown) => {
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

const shielded = async <T>(deps: CliDeps, action: () => Promise<T>) => {
  const source = deps.signals ?? process;
  const ignore = () => undefined;

  PREPARATION_SIGNALS.forEach((name) => {
    source.on(name, ignore);
  });

  try {
    return await action();
  } finally {
    PREPARATION_SIGNALS.forEach((name) => {
      source.off(name, ignore);
    });
  }
};

const prepareVm = async (input: SandboxInput, share: boolean) => {
  const { deps, context, backend, sessions, launch, staged, progress } = input;

  if (!share) {
    await staged("vm", () => startVm(backend, sessions, progress));

    return;
  }

  const plan = await prepareVmShares(deps, context.effective.config.workspaceRoots);

  await staged("vm", () => startVm(backend, sessions, progress, plan));

  await staged("shares", () =>
    shareVm(deps, context, backend, { sessions, launchId: launch.launchId, plan }),
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

  return { host: prepared.host, ...(await prepareSandbox({ ...input, prepared })) };
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
    denials = reportDenials(deps, context),
    writeBack = false,
  }: SandboxOptions = {},
) => {
  const staged = stagedWith(report);
  const files = await readHostPiFiles(hostAgentDirOf(deps));
  const sessions = hostSessionsOf(deps, context, files.settings);
  const launch = await beginLaunch(deps, context);
  const signal = firstSignal(deps);
  const cancel = new AbortController();
  const deriving = startHostSide(deps, context, files, launch.launchId);
  const preparation = prepareAll(
    { deps, context, backend, launch, sessions, cancelled: cancel.signal, staged, progress, writeBack },
    { deriving, signIn, share },
  );
  const ended: { proxy?: SandboxProxy; sync?: VolumeSync } = {};

  try {
    const outcome = await Promise.race([
      preparation.then((ready) => ({ ready })),
      signal.received.then((name) => ({ name })),
    ]);

    if ("name" in outcome) {
      cancel.abort();

      await preparation.catch(() => undefined);

      return SIGNAL_EXIT_BASE + constants.signals[outcome.name];
    }

    signal.stop();

    const { prepared, proxy, host } = outcome.ready;

    ended.proxy = proxy;
    ended.sync = { containerId: prepared.containerId, hostAgentDir: host.hostAgentDir, writeBack };

    return await use({ ...prepared, backend, host, proxy, launch });
  } finally {
    signal.stop();

    await shielded(deps, async () => {
      if (ended.proxy !== undefined) {
        denials(await sandboxDenials(deps, context, launch.startedAt));
      }

      if (ended.sync?.writeBack === true) {
        await syncVolume(deps, context, backend, ended.sync).catch((error: unknown) => {
          writeLine(
            deps.stderr,
            `pi-sandbox: warning: settings were not written back: ${errorMessage(error)}`,
          );
        });
      }

      await finishLaunch(deps, context, backend, launch);
    });
  }
};

const runSandboxPi = async (deps: CliDeps, context: LaunchContext, sandbox: Sandbox, piArgs: string[]) => {
  writeNotices(deps, await hostPathNotices(piArgs, context.workspace.cwd, sandbox.spec.mounts));

  return runPi({
    backend: sandbox.backend,
    containerId: sandbox.containerId,
    piArgs,
    env: forwardedEnv(context.effective.config.env.allow, deps.env, (notice) => writeNotices(deps, [notice])),
    launchId: sandbox.launch.launchId,
    workspace: context.workspace,
    terminal: deps.terminal,
    signals: deps.signals,
  });
};

export const launch = async (args: string[], deps: CliDeps) => {
  const piArgs = args.filter((arg) => arg !== NO_SANDBOX);

  writeNotices(deps, await legacyNotices(deps));

  if (piArgs.length !== args.length) {
    const { context } = await openContext(deps, "host");

    checkWorkspaceRoots(context);

    return runHostPi(deps, context, piArgs);
  }

  const { context, backend } = await openContext(deps, "sandbox");

  return withSandbox(deps, context, backend, (sandbox) => runSandboxPi(deps, context, sandbox, piArgs), {
    writeBack: true,
  });
};
