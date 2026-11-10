import { constants } from "node:os";
import type { Backend } from "../backend/index.ts";
import {
  buildContainerSpec,
  ensureContainer,
  findCurrentContainer,
  forwardedEnv,
  type GitOverlay,
  type LauncherContainerSpec,
  planGitOverlay,
  runPi,
} from "../container/index.ts";
import type { Launch } from "../grants/index.ts";
import { type HostPiFiles, readHostPiFiles } from "../hostpi/index.ts";
import { ensureSandboxImage, type SandboxImage } from "../image/index.ts";
import { renderAgentDir, syncSettingsFile } from "../provision/index.ts";
import { guestProxyUrl } from "../proxy/index.ts";
import { errorMessage, settleAll, sha256Hex } from "../shared/index.ts";
import {
  gitLaunchNotices,
  type HostSessions,
  resolveHostCaches,
  withGitPinLock,
} from "../workspace/index.ts";
import { checkWorkspaceRoots, type LaunchContext, openContext } from "./context.ts";
import { type CliDeps, hostAgentDirOf, writeLine, writeNotices } from "./deps.ts";
import { type HostSide, type PreparedHost, prepareHostSide } from "./derive.ts";
import { NO_SANDBOX, resolveJobPi, runHostPi, sandboxRoots } from "./host-pi.ts";
import {
  hostSessionsOf,
  noticeHostSessions,
  probeSessionsShare,
  readyHostSessions,
} from "./host-sessions.ts";
import { launchNotices, proxyDetail } from "./launch-notices.ts";
import { beginLaunch, finishLaunch, gitGuardOf, othersLive } from "./launches.ts";
import { signInMcpServers } from "./mcp-sign-in.ts";
import { writeOnce } from "./notices.ts";
import { openSandboxProxy, reportDenials, type SandboxProxy } from "./sandbox-proxy.ts";
import { sweepOrphans } from "./sweep.ts";
import { imagePiVersion, launcherVersion } from "./versions.ts";
import { hostCacheContext, shareVm, startVm } from "./vm.ts";

interface PreparedContainer {
  containerId: string;
  spec: LauncherContainerSpec;
  image: SandboxImage;
}

export interface Sandbox extends PreparedContainer {
  backend: Backend;
  host: HostSide;
  proxy?: SandboxProxy;
  launch: Launch;
}

export type Stage = "vm" | "shares" | "host" | "proxy" | "image" | "container" | "sync";

export type StageOutcome = { ok: true; detail?: string } | { ok: false; error: unknown };

type StageReport = (stage: Stage, outcome: StageOutcome) => void;

interface SandboxOptions {
  report?: StageReport;
  signIn?: boolean;
  share?: boolean;
}

type Staged = <T>(stage: Stage, action: () => Promise<T>, detail?: (value: T) => string) => Promise<T>;

interface SandboxInput {
  deps: CliDeps;
  context: LaunchContext;
  backend: Backend;
  prepared: PreparedHost;
  launch: Launch;
  sessions: HostSessions;
  cancelled: AbortSignal;
  staged: Staged;
}

const PREPARING = "preparing pi sandbox, one time";

const STOPPING = "pi-sandbox: stopping after the current step";

const PREPARATION_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

const SIGNAL_EXIT_BASE = 128;

const TOKEN_HASH_LENGTH = 16;

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
  handled(
    resolveJobPi(deps, sandboxRoots(deps, context)).then((pi) => prepareHostSide(deps, context, files, pi)),
  );

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
  host: HostSide,
): Promise<SandboxImage> =>
  ensureSandboxImage({
    backend,
    config: context.effective.config,
    stateDir: context.stateDir,
    repoHash: context.repoHash,
    env: deps.env,
    trustPem: host.trust?.extraPemPath,
    proxyCaPem: host.trust?.caCertPath,
    versions: async () => ({ pi: await imagePiVersion(host.pi) }),
    inUse: async (digest) => (await findCurrentContainer(backend, context.workspace, digest)) !== undefined,
    preparing: () => writeLine(deps.stderr, PREPARING),
    waiting: () => writeLine(deps.stderr, "pi-sandbox: waiting for the image build in another session"),
    progress: (step) => writeLine(deps.stderr, `pi-sandbox: build: ${step}`),
  });

const sandboxRoute = async (
  backend: Backend,
  proxy: SandboxProxy | undefined,
  imageId: string,
  repoHash: string,
) => {
  if (proxy === undefined) {
    return undefined;
  }

  const route = await backend.prepareProxyRoute({ hostPort: proxy.proxy.port, repoHash, imageId });

  return {
    url: guestProxyUrl(route, proxy.token),
    network: route.network,
    tokenHash: sha256Hex(proxy.token).slice(0, TOKEN_HASH_LENGTH),
  };
};

const syncAgentFiles = async (input: SandboxInput, id: string) => {
  const { deps, context, backend } = input;
  const { host } = input.prepared;
  const { notices } = await syncSettingsFile({
    backend,
    containerId: id,
    stateDir: context.stateDir,
    repoHash: context.repoHash,
    hostAgentDir: host.hostAgentDir,
    repoRoot: context.workspace.repoRoot,
    config: context.effective.config,
    hostSettings: host.files.settings,
  });

  writeNotices(deps, notices);
};

const prepareGround = async (input: SandboxInput) => {
  const { deps, context, backend, launch, sessions } = input;
  const { host } = input.prepared;
  const [render, gitNotices, version, git] = await settleAll([
    renderAgentDir({
      stateDir: context.stateDir,
      repoHash: context.repoHash,
      hostAgentDir: host.hostAgentDir,
      derived: host.derived,
    }),
    gitLaunchNotices(context.workspace),
    launcherVersion(),
    planGitOverlay(context.workspace, gitGuardOf(deps, context)),
    readyHostSessions(deps, context, backend, { sessions, launchId: launch.launchId }),
  ]);

  return { render, gitNotices, version, git };
};

type Ground = Awaited<ReturnType<typeof prepareGround>>;

const prepareContainer = async (
  input: SandboxInput,
  parts: { proxy?: SandboxProxy; image: SandboxImage; ground: Promise<Ground> },
): Promise<PreparedContainer> => {
  const { deps, context, backend, launch, sessions, cancelled } = input;
  const { host } = input.prepared;
  const { proxy, image } = parts;
  const [ground, route, privateNotices] = await settleAll([
    parts.ground,
    sandboxRoute(backend, proxy, image.id, context.repoHash),
    input.prepared.privateNotices,
  ]);
  const { render, gitNotices, version, git } = ground;

  writeNotices(deps, [...render.notices, ...gitNotices]);

  await writeOnce(deps, context, [...launchNotices(context, host, image), ...privateNotices]);

  const hostCaches = resolveHostCaches(
    context.effective.config.mounts.hostCaches,
    hostCacheContext(deps, context),
  );
  const specWith = (gitOverlay: GitOverlay) =>
    buildContainerSpec({
      workspace: context.workspace,
      config: context.effective.config,
      image,
      hostEnv: deps.env,
      hostUid: deps.uid,
      stateDir: context.stateDir,
      gitOverlay,
      proxy: route,
      launcherVersion: version,
      renderDir: render.renderDir,
      trust: route === undefined ? undefined : host.trust,
      hostSessions: sessions,
      toolEnv: host.derived.tools.env,
      hostCaches,
    });
  const planned = specWith(git.overlay);

  cancelled.throwIfAborted();

  const { id, spec, notices } = await ensureContainer({
    backend,
    spec: planned,
    stateDir: context.stateDir,
    othersLive: () => othersLive(context.stateDir, context.repoHash, launch.launchId),
    beforeStart: async () => specWith(await git.ready()),
    aroundStart: (start) => withGitPinLock(context.stateDir, context.workspace, start),
    afterCreate: (created) => probeSessionsShare(backend, created, sessions),
  });

  writeNotices(deps, notices);

  return { containerId: id, spec, image };
};

const prepareSandbox = async (input: SandboxInput) => {
  const { deps, context, backend, launch, cancelled, staged } = input;
  const { host } = input.prepared;
  const pending = [
    openSandboxProxy(deps, context, host, launch),
    prepareImage(deps, context, backend, host),
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
    writeLine(deps.stderr, `pi-sandbox: warning: settings.json was not synced: ${errorMessage(error)}`);
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

const prepareVm = async (
  deps: CliDeps,
  context: LaunchContext,
  backend: Backend,
  parts: { staged: Staged; sessions: HostSessions; deriving: Promise<PreparedHost>; share: boolean },
) => {
  const { staged, sessions, share } = parts;

  try {
    await staged("vm", () => startVm(deps, context, backend, { sessions, share }));

    if (share) {
      await staged("shares", () => shareVm(deps, context, backend, sessions));
    }
  } catch (error) {
    await parts.deriving.catch(() => undefined);

    throw error;
  }
};

export const withSandbox = async (
  deps: CliDeps,
  context: LaunchContext,
  backend: Backend,
  use: (sandbox: Sandbox) => Promise<number>,
  { report = () => undefined, signIn = true, share = true }: SandboxOptions = {},
) => {
  const staged = stagedWith(report);
  const files = await readHostPiFiles(hostAgentDirOf(deps));
  const sessions = hostSessionsOf(deps, context, files.settings);
  const deriving = startHostSide(deps, context, files);

  await prepareVm(deps, context, backend, { staged, sessions, deriving, share });

  const prepared = await staged("host", () =>
    prepareHost(deps, context, backend, { deriving, sessions, signIn }),
  );
  const launch = await beginLaunch(deps, context);
  const signal = firstSignal(deps);
  const cancel = new AbortController();
  const preparation = prepareSandbox({
    deps,
    context,
    backend,
    prepared,
    launch,
    sessions,
    cancelled: cancel.signal,
    staged,
  });
  const ended: { proxy?: SandboxProxy } = {};

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

    ended.proxy = outcome.ready.proxy;

    return await use({ ...outcome.ready.prepared, backend, host: prepared.host, proxy: ended.proxy, launch });
  } finally {
    signal.stop();

    await shielded(deps, async () => {
      await reportDenials(deps, context, ended.proxy, launch.startedAt);

      await finishLaunch(deps, context, backend, launch);
    });
  }
};

const runSandboxPi = (deps: CliDeps, context: LaunchContext, sandbox: Sandbox, piArgs: string[]) =>
  runPi({
    backend: sandbox.backend,
    containerId: sandbox.containerId,
    piArgs,
    env: forwardedEnv(context.effective.config.env.allow, deps.env),
    launchId: sandbox.launch.launchId,
    workspace: context.workspace,
    terminal: deps.terminal,
    signals: deps.signals,
  });

export const launch = async (args: string[], deps: CliDeps) => {
  const piArgs = args.filter((arg) => arg !== NO_SANDBOX);

  if (piArgs.length !== args.length) {
    const { context } = await openContext(deps, "host");

    checkWorkspaceRoots(deps, context);

    return runHostPi(deps, context, piArgs);
  }

  const { context, backend } = await openContext(deps, "sandbox");

  return withSandbox(deps, context, backend, (sandbox) => runSandboxPi(deps, context, sandbox, piArgs));
};
