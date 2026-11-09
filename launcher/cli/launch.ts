import { constants } from "node:os";
import { resolve } from "node:path";
import type { Backend, ProxyRoute, VmPath } from "../backend/index.ts";
import { type EffectiveConfig, loadEffectiveConfig } from "../config/index.ts";
import {
  buildContainerSpec,
  ensureContainer,
  findCurrentContainer,
  forwardedEnv,
  type GitOverlay,
  gitLaunchNotices,
  type LauncherContainerSpec,
  listenFor,
  nodeModulesOverlays,
  planGitOverlay,
  runPi,
} from "../container/index.ts";
import type { Launch } from "../grants/index.ts";
import { ensureSandboxImage, type SandboxImage } from "../image/index.ts";
import { renderAgentDir, syncSettingsFile } from "../provision/index.ts";
import { guestProxyUrl } from "../proxy/index.ts";
import {
  errorMessage,
  expandHome,
  LauncherError,
  realOrResolvedSync,
  repoHash,
  settleAll,
  sha256Hex,
  stateLayout,
} from "../shared/index.ts";
import {
  assertSafeWorkspace,
  assertWithinWorkspaceRoots,
  discoverWorkspace,
  type HostSessions,
  mountedGitDirs,
  type Workspace,
  withGitPinLock,
  workspaceNotices,
} from "../workspace/index.ts";
import {
  type CliDeps,
  pathsOf,
  reachableBackend,
  withFallbackHint,
  writeLine,
  writeLines,
  writeNotices,
} from "./deps.ts";
import { type HostSide, prepareHostSide } from "./derive.ts";
import { hostPiCommand, resolveJobPi, sandboxRoots } from "./host-pi.ts";
import {
  hostSessionsOf,
  noticeHostSessions,
  probeSessionsShare,
  readyHostSessions,
  sweepForHostPi,
} from "./host-sessions.ts";
import { beginLaunch, busyLaunches, finishLaunch, gitGuardOf, othersLive } from "./launches.ts";
import { signInMcpServers } from "./mcp-sign-in.ts";
import { openSandboxProxy, reportDenials, type SandboxProxy } from "./sandbox-proxy.ts";
import { sweepOrphans } from "./sweep.ts";
import { imagePiVersion, launcherVersion } from "./versions.ts";

export interface LaunchContext {
  workspace: Workspace;
  effective: EffectiveConfig;
  stateDir: string;
  repoHash: string;
}

interface PreparedContainer {
  containerId: string;
  spec: LauncherContainerSpec;
  image: SandboxImage;
  created: boolean;
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
}

type Staged = <T>(stage: Stage, action: () => Promise<T>, detail?: (value: T) => string) => Promise<T>;

interface SandboxInput {
  deps: CliDeps;
  context: LaunchContext;
  backend: Backend;
  host: HostSide;
  launch: Launch;
  sessions: HostSessions;
  cancelled: AbortSignal;
  staged: Staged;
}

type ContextMode = "sandbox" | "admin" | "host";

type Opened<M extends ContextMode> = M extends "host"
  ? { context: LaunchContext }
  : { context: LaunchContext; backend: Backend };

const NO_SANDBOX = "--no-sandbox";

const PREPARING = "preparing pi sandbox, one time";

const PREPARATION_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

const SIGNAL_EXIT_BASE = 128;

const discoverContext = async (deps: CliDeps, lenient: boolean): Promise<LaunchContext> => {
  const stateDir = pathsOf(deps).stateDir;
  const workspace = await discoverWorkspace(deps.cwd, deps.runner, stateLayout(stateDir).gitNoHooks, {
    lenient,
  });
  const effective = await loadEffectiveConfig({ repoRoot: workspace.repoRoot, env: deps.env });

  return { workspace, effective, stateDir, repoHash: repoHash(workspace.repoRoot) };
};

const checkWorkspaceRoots = (deps: CliDeps, context: LaunchContext) => {
  const roots = context.effective.config.workspaceRoots;

  if (assertWithinWorkspaceRoots(context.workspace, roots) === "warn") {
    writeLine(
      deps.stderr,
      `pi-sandbox: warning: ${context.workspace.repoRoot} is outside the workspace roots (${roots?.roots.join(", ")})`,
    );
  }
};

const checkWorkspace = (deps: CliDeps, context: LaunchContext) => {
  checkWorkspaceRoots(deps, context);

  assertSafeWorkspace(context.workspace, { home: deps.home, env: deps.env });
};

export const openContext = async <M extends ContextMode>(deps: CliDeps, mode: M): Promise<Opened<M>> => {
  const context = await discoverContext(deps, mode !== "sandbox");

  if (mode === "host") {
    return { context } as Opened<M>;
  }

  if (mode === "admin") {
    return { context, backend: await reachableBackend(deps, context.effective.config) } as Opened<M>;
  }

  checkWorkspace(deps, context);

  return { context, backend: deps.backend() } as Opened<M>;
};

export const vmPathsOf = (deps: CliDeps, context: LaunchContext): VmPath[] => {
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

const withHint = async <T>(context: LaunchContext, action: () => Promise<T>) => {
  try {
    return await action();
  } catch (error) {
    throw withFallbackHint(error, context.effective.config.fallback);
  }
};

const startVm = (deps: CliDeps, context: LaunchContext, backend: Backend) =>
  withHint(context, () => backend.vm.ensureRunning((notice) => writeNotices(deps, [notice])));

const shareVm = (deps: CliDeps, context: LaunchContext, backend: Backend) =>
  withHint(context, () =>
    backend.vm.ensureShares(vmPathsOf(deps, context), {
      busy: () => busyLaunches(context.stateDir),
      report: (notice) => writeNotices(deps, [notice]),
    }),
  );

const TOKEN_HASH_LENGTH = 16;

const prepareHost = async (deps: CliDeps, context: LaunchContext, backend: Backend) => {
  const [host] = await settleAll([
    resolveJobPi(deps).then((pi) => prepareHostSide(deps, context, pi)),
    sweepOrphans(deps, backend),
  ]);
  const sessions = hostSessionsOf(deps, context, host.files.settings);

  noticeHostSessions(deps, sessions);

  await signInMcpServers(deps, context, host);

  return { host, sessions };
};

const isPinned = (context: LaunchContext) => context.effective.config.image.digest !== undefined;

const prepareImage = (
  deps: CliDeps,
  context: LaunchContext,
  backend: Backend,
  host: Partial<Pick<HostSide, "trust" | "pi">>,
): Promise<SandboxImage> => {
  const { config } = context.effective;

  return ensureSandboxImage({
    backend,
    config,
    stateDir: context.stateDir,
    repoHash: context.repoHash,
    env: deps.env,
    trustPem: host.trust?.extraPemPath,
    proxyCaPem: host.trust?.caCertPath,
    versions: async () => ({ pi: await imagePiVersion(host.pi) }),
    inUse: async (digest) => (await findCurrentContainer(backend, context.workspace, digest)) !== undefined,
    preparing: () => writeLine(deps.stderr, PREPARING),
  });
};

const sandboxRoute = async (
  deps: CliDeps,
  backend: Backend,
  proxy: SandboxProxy | undefined,
  imageId: string,
  repoHash: string,
) => {
  if (proxy === undefined) {
    return undefined;
  }

  const route: ProxyRoute = await backend.prepareProxyRoute({
    hostPort: proxy.proxy.port,
    repoHash,
    imageId,
  });

  writeNotices(deps, route.notices ?? []);

  return {
    url: guestProxyUrl(route, proxy.token),
    network: route.network,
    tokenHash: sha256Hex(proxy.token).slice(0, TOKEN_HASH_LENGTH),
  };
};

const CAPPED_NOTICE =
  "pi-sandbox: more than 512 node_modules directories; overlay disabled, host node_modules is used";

const overlayNotices = (context: LaunchContext) => {
  if (context.workspace.nodeProjectsCapped === true) {
    return [CAPPED_NOTICE];
  }

  const count = nodeModulesOverlays(context.workspace, context.effective.config).length;

  if (count === 0) {
    return [];
  }

  const places = count === 1 ? "1 directory" : `${count} directories`;

  return [
    `pi-sandbox: node_modules overlaid in ${places}; host node_modules is hidden; set mounts.autoNodeModules=false to keep it`,
  ];
};

const writeLaunchNotices = (deps: CliDeps, context: LaunchContext) => {
  writeLines(deps.stderr, [...workspaceNotices(context.workspace), ...overlayNotices(context)]);
};

const syncAgentFiles = async (input: SandboxInput, id: string) => {
  const { deps, context, backend, host } = input;
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

const prepareContainer = async (
  input: SandboxInput,
  parts: { proxy?: SandboxProxy; image: SandboxImage },
): Promise<PreparedContainer> => {
  const { deps, context, backend, host, launch, sessions, cancelled } = input;
  const { proxy, image } = parts;
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

  writeNotices(deps, gitNotices);

  writeLaunchNotices(deps, context);

  const route = await sandboxRoute(deps, backend, proxy, image.id, context.repoHash);
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
    });
  const planned = specWith(git.overlay);

  cancelled.throwIfAborted();

  const { id, created, spec, notices } = await ensureContainer({
    backend,
    spec: planned,
    stateDir: context.stateDir,
    othersLive: () => othersLive(context.stateDir, context.repoHash, launch.launchId),
    beforeStart: async () => specWith(await git.ready()),
    aroundStart: (start) => withGitPinLock(context.stateDir, context.workspace, start),
  });

  writeNotices(deps, notices);

  if (created) {
    await probeSessionsShare(backend, context, id, sessions);
  }

  return { containerId: id, spec, image, created };
};

const imagePiNotices = (context: LaunchContext, host: HostSide, image: SandboxImage) =>
  host.pi === undefined || isPinned(context) || image.pi === host.pi.version
    ? []
    : [
        `the sandbox image has pi ${image.pi ?? "of an unrecorded version"}, the host pi ${host.pi.version}; the image is rebuilt after every session in this repository exits`,
      ];

const proxyDetail = (proxy: SandboxProxy | undefined) =>
  proxy === undefined
    ? "not required, no credential rule and an empty allowlist"
    : `pid ${proxy.proxy.pid} port ${proxy.proxy.port}`;

const prepareSandbox = async (input: SandboxInput) => {
  const { deps, context, backend, host, launch, cancelled, staged } = input;
  const pending = [
    openSandboxProxy(deps, context, host, launch),
    prepareImage(deps, context, backend, host),
  ] as const;

  await Promise.allSettled(pending);

  const [proxy, image] = await settleAll([
    staged("proxy", () => pending[0], proxyDetail),
    staged(
      "image",
      () => pending[1],
      (ready) => `${ready.reference} ${ready.digest}`,
    ),
  ]);

  writeNotices(deps, imagePiNotices(context, host, image));

  cancelled.throwIfAborted();

  const prepared = await staged("container", () => prepareContainer(input, { proxy, image }));

  cancelled.throwIfAborted();

  await staged("sync", () => syncAgentFiles(input, prepared.containerId)).catch((error: unknown) => {
    writeLine(deps.stderr, `pi-sandbox: warning: settings.json was not synced: ${errorMessage(error)}`);
  });

  return { prepared, proxy };
};

export const withSandbox = async (
  deps: CliDeps,
  context: LaunchContext,
  backend: Backend,
  use: (sandbox: Sandbox) => Promise<number>,
  { report = () => undefined }: SandboxOptions = {},
) => {
  const staged = stagedWith(report);

  await staged("vm", () => startVm(deps, context, backend));

  await staged("shares", () => shareVm(deps, context, backend));

  const { host, sessions } = await staged("host", () => prepareHost(deps, context, backend));
  const launch = await beginLaunch(deps, context);
  const watch = listenFor(deps.signals ?? process, PREPARATION_SIGNALS);
  const cancel = new AbortController();
  const preparation = prepareSandbox({
    deps,
    context,
    backend,
    host,
    launch,
    sessions,
    cancelled: cancel.signal,
    staged,
  });

  try {
    const outcome = await Promise.race([
      preparation.then((ready) => ({ ready })),
      watch.received.then((signal) => ({ signal })),
    ]);

    watch.stop();

    if ("signal" in outcome) {
      cancel.abort();

      await preparation.catch(() => undefined);

      return SIGNAL_EXIT_BASE + constants.signals[outcome.signal];
    }

    const { prepared, proxy } = outcome.ready;

    try {
      return await use({ ...prepared, backend, host, proxy, launch });
    } finally {
      await reportDenials(deps, context, proxy, launch.startedAt);
    }
  } finally {
    watch.stop();

    await finishLaunch(deps, context, backend, launch);
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

const runHostPi = async (deps: CliDeps, context: LaunchContext, piArgs: string[]) => {
  const { config, sources } = context.effective;

  if (config.fallback === "refuse") {
    throw new LauncherError(
      `${NO_SANDBOX} is refused: fallback is "refuse", set by ${sources.fallback ?? "default"}`,
      "run pi without --no-sandbox",
    );
  }

  const command = (await hostPiCommand(deps, sandboxRoots(deps, context))) ?? [];
  const [file, ...prefix] = command;

  if (file === undefined) {
    throw new LauncherError(
      `${NO_SANDBOX}: no pi on the host`,
      "install pi on the host, or reinstall the launcher with npm install -g pi-extensions-mz",
    );
  }

  writeLine(deps.stderr, `pi-sandbox: warning: running ${command.at(-1)} on the host, outside the sandbox`);

  await sweepForHostPi(deps, context);

  return deps.runner.spawnInteractive(file, [...prefix, ...piArgs], { cwd: deps.cwd });
};

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
