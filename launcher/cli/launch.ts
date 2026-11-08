import { constants } from "node:os";
import type { Backend, ProxyRoute } from "../backend/index.ts";
import {
  configHash,
  type EffectiveConfig,
  loadEffectiveConfig,
  type SandboxConfig,
} from "../config/index.ts";
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
import type { HostPi } from "../hostpi/index.ts";
import {
  ensureSandboxImage,
  recordedImage,
  resolveExtensionsSource,
  type SandboxImage,
} from "../image/index.ts";
import { renderAgentDir, syncWritableFiles } from "../provision/index.ts";
import { guestProxyUrl } from "../proxy/index.ts";
import { errorMessage, LauncherError, launcherRoot, repoHash, stateLayout } from "../shared/index.ts";
import {
  assertSafeWorkspace,
  assertWithinWorkspaceRoots,
  discoverWorkspace,
  type HostSessions,
  type Workspace,
  withGitPinLock,
  workspaceNotices,
} from "../workspace/index.ts";
import {
  type CliDeps,
  pathsOf,
  settleAll,
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
  sessionsSweeper,
  sweepForHostPi,
} from "./host-sessions.ts";
import { syncSandboxMcpAuth } from "./mcp-auth-sync.ts";
import { openSandboxProxy, reportDenials, type SandboxProxy } from "./sandbox-proxy.ts";
import {
  beginSession,
  finishSession,
  gitGuardOf,
  type LaunchSession,
  othersLive,
  pruneEndedGrants,
} from "./sessions.ts";
import { imagePiVersion, launcherVersion } from "./versions.ts";
import { openLaunchBackend, reachableBackend } from "./vm-lifecycle.ts";
import { ensureVmShares } from "./vm-shares.ts";

export interface LaunchContext {
  workspace: Workspace;
  effective: EffectiveConfig;
  stateDir: string;
  repoHash: string;
}

export interface PreparedContainer {
  containerId: string;
  spec: LauncherContainerSpec;
  image: SandboxImage;
  created: boolean;
}

export interface SandboxParts {
  host: HostSide;
  proxy?: SandboxProxy;
  image: SandboxImage;
  session: LaunchSession;
  sessions: HostSessions;
  cancelled?: AbortSignal;
}

export interface Sandbox extends PreparedContainer {
  backend: Backend;
  host: HostSide;
  proxy?: SandboxProxy;
  session: LaunchSession;
}

const NO_SANDBOX = "--no-sandbox";

const PREPARING = "preparing pi sandbox, one time";

const PREPARATION_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

const SIGNAL_EXIT_BASE = 128;

interface ContextOptions {
  offline?: boolean;
  lenient?: boolean;
}

export const openContext = async (
  deps: CliDeps,
  { offline = false, lenient = false }: ContextOptions = {},
): Promise<LaunchContext> => {
  const stateDir = pathsOf(deps).stateDir;
  const workspace = await discoverWorkspace(deps.cwd, deps.runner, stateLayout(stateDir).gitNoHooks, {
    lenient,
  });
  const { notices, ...effective } = await loadEffectiveConfig({
    repoRoot: workspace.repoRoot,
    env: deps.env,
    home: deps.home,
    offline,
  });

  writeNotices(deps, notices);

  return { workspace, effective, stateDir, repoHash: repoHash(workspace.repoRoot) };
};

export const openAdminContext = (deps: CliDeps) => openContext(deps, { lenient: true });

const checkWorkspaceRoots = (deps: CliDeps, context: LaunchContext) => {
  const roots = context.effective.config.workspaceRoots;

  if (assertWithinWorkspaceRoots(context.workspace, roots) === "warn") {
    writeLine(
      deps.stderr,
      `pi-sandbox: warning: ${context.workspace.repoRoot} is outside the workspace roots (${roots?.roots.join(", ")})`,
    );
  }
};

export const checkWorkspace = (deps: CliDeps, context: LaunchContext) => {
  checkWorkspaceRoots(deps, context);

  assertSafeWorkspace(context.workspace, { home: deps.home, env: deps.env, platform: deps.platform });
};

export const openBackend = async (deps: CliDeps, config: SandboxConfig) => {
  try {
    return await reachableBackend(deps);
  } catch (error) {
    throw withFallbackHint(error, config.fallback);
  }
};

const isPinned = (context: LaunchContext) => context.effective.config.image.digest !== undefined;

const hostPiMoved = async (context: LaunchContext, pi: HostPi | undefined) => {
  if (pi === undefined || isPinned(context)) {
    return false;
  }

  return (await recordedImage(context.stateDir, context.effective.config))?.pi !== pi.version;
};

export const prepareImage = (
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
    env: deps.env,
    trustPem: host.trust?.extraPemPath,
    versions: async () => ({
      pi: await imagePiVersion(host.pi),
      extensions: await resolveExtensionsSource({
        launcherRoot: launcherRoot(),
        runner: deps.runner,
        stateDir: context.stateDir,
      }),
    }),
    inUse: async (digest) => {
      const found = await findCurrentContainer(backend, context.workspace, digest, configHash(config));

      return found !== undefined && (found.state === "running" || !(await hostPiMoved(context, host.pi)));
    },
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
    hostPort: proxy.instance.port,
    repoHash,
    relay: { policyHash: proxy.policyHash, imageId },
  });

  writeNotices(deps, route.notices ?? []);

  return { url: guestProxyUrl(route, proxy.repoToken), network: route.network, policyHash: proxy.policyHash };
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

const syncAgentFiles = async (
  deps: CliDeps,
  context: LaunchContext,
  backend: Backend,
  host: HostSide,
  id: string,
) => {
  try {
    const { notices } = await syncWritableFiles({
      backend,
      containerId: id,
      stateDir: context.stateDir,
      repoHash: context.repoHash,
      hostAgentDir: host.hostAgentDir,
      repoRoot: context.workspace.repoRoot,
      config: context.effective.config,
      hostSettings: host.files.settings,
      mcp: host.derived.files["mcp.json"],
    });

    writeNotices(deps, notices);
  } catch (error) {
    writeLine(
      deps.stderr,
      `pi-sandbox: warning: settings.json and mcp.json were not synced: ${errorMessage(error)}`,
    );
  }
};

export const prepareContainer = async (
  deps: CliDeps,
  context: LaunchContext,
  backend: Backend,
  parts: SandboxParts,
): Promise<PreparedContainer> => {
  const { host, proxy, image, session, sessions, cancelled } = parts;
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
    readyHostSessions(deps, context, backend, { sessions, launchId: session.launchId }),
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
      configHash: configHash(context.effective.config),
      renderDir: render.renderDir,
      trust: route === undefined ? undefined : host.trust,
      repoProxyToken: proxy?.repoToken,
      hostSessions: sessions,
    });
  const wanted = specWith(git.overlay);

  cancelled?.throwIfAborted();

  const { id, created, spec, notices } = await ensureContainer({
    backend,
    spec: wanted,
    othersLive: () => othersLive(context.stateDir, context.repoHash, session.launchId),
    beforeStart: async () => specWith(await git.ready()),
    aroundStart: (start) => withGitPinLock(context.stateDir, context.workspace, start),
  });

  writeNotices(deps, notices);

  if (created) {
    await probeSessionsShare(backend, context, id, sessions);

    await pruneEndedGrants(deps, context.stateDir);
  }

  cancelled?.throwIfAborted();

  await Promise.all([
    syncAgentFiles(deps, context, backend, host, id),
    syncSandboxMcpAuth(deps, context, { backend, containerId: id, servers: host.derived.vault }),
  ]);

  return { containerId: id, spec, image, created };
};

const imagePiNotices = (context: LaunchContext, host: HostSide, image: SandboxImage) =>
  host.pi === undefined || isPinned(context) || image.pi === host.pi.version
    ? []
    : [
        `the sandbox image has pi ${image.pi ?? "of an unrecorded version"}, the host pi ${host.pi.version}; the image is rebuilt after every session in this repository exits`,
      ];

const prepareSandbox = async (
  deps: CliDeps,
  context: LaunchContext,
  backend: Backend,
  host: HostSide,
  session: LaunchSession,
  sessions: HostSessions,
  cancelled: AbortSignal,
) => {
  const [proxy, image] = await settleAll([
    openSandboxProxy(deps, context, host),
    prepareImage(deps, context, backend, host),
  ]);

  writeNotices(deps, imagePiNotices(context, host, image));

  cancelled.throwIfAborted();

  const prepared = await prepareContainer(deps, context, backend, {
    host,
    proxy,
    image,
    session,
    sessions,
    cancelled,
  });

  return { prepared, proxy };
};

export const withSandbox = async (
  deps: CliDeps,
  context: LaunchContext,
  backend: Backend,
  use: (sandbox: Sandbox) => Promise<number>,
) => {
  await ensureVmShares(deps, context, backend);

  const host = await prepareHostSide(deps, context, await resolveJobPi(deps));
  const sessions = hostSessionsOf(deps, context, host.files.settings);

  noticeHostSessions(deps, sessions);

  const session = await beginSession(deps, context);
  const watch = listenFor(deps.signals ?? process, PREPARATION_SIGNALS);
  const cancel = new AbortController();
  const preparation = prepareSandbox(deps, context, backend, host, session, sessions, cancel.signal);

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
      return await use({ ...prepared, backend, host, proxy, session });
    } finally {
      await reportDenials(deps, context, proxy, session.startedAt);
    }
  } finally {
    watch.stop();

    await finishSession(deps, context, backend, session, sessionsSweeper(deps, context));
  }
};

export const runSandboxPi = (deps: CliDeps, context: LaunchContext, sandbox: Sandbox, piArgs: string[]) =>
  runPi({
    backend: sandbox.backend,
    containerId: sandbox.containerId,
    piArgs,
    env: forwardedEnv(context.effective.config.env.allow, deps.env),
    launchId: sandbox.session.launchId,
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

export const openSandboxContext = async (deps: CliDeps) => {
  const context = await openContext(deps);

  checkWorkspace(deps, context);

  return { context, backend: await openLaunchBackend(deps, context.effective.config, context.stateDir) };
};

export const launch = async (args: string[], deps: CliDeps) => {
  const piArgs = args.filter((arg) => arg !== NO_SANDBOX);

  if (piArgs.length !== args.length) {
    const context = await openContext(deps, { offline: true, lenient: true });

    checkWorkspaceRoots(deps, context);

    return runHostPi(deps, context, piArgs);
  }

  const { context, backend } = await openSandboxContext(deps);

  return withSandbox(deps, context, backend, (sandbox) => runSandboxPi(deps, context, sandbox, piArgs));
};
