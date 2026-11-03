import type { Backend, ProxyRoute } from "../backend/index.ts";
import { selectBackend } from "../backend/index.ts";
import {
  configHash,
  type EffectiveConfig,
  loadEffectiveConfig,
  type SandboxConfig,
} from "../config/index.ts";
import {
  buildContainerSpec,
  discoverGitOverlay,
  ensureContainer,
  findCurrentContainer,
  forwardedEnv,
  type LauncherContainerSpec,
  runPi,
} from "../container/index.ts";
import { ensureBuiltImage, recordedImage, resolveExtensionsSource } from "../image/index.ts";
import { guestProxyUrl } from "../proxy/index.ts";
import { errorMessage, LauncherError, launcherRoot } from "../shared/index.ts";
import {
  assertSafeWorkspace,
  assertWithinWorkspaceRoots,
  discoverWorkspace,
  type Workspace,
} from "../workspace/index.ts";
import { type CliDeps, pathsOf, writeLine } from "./deps.ts";
import { findHostPi } from "./host-pi.ts";
import { launcherVersion, piVersion } from "./versions.ts";

export interface LaunchContext {
  workspace: Workspace;
  effective: EffectiveConfig;
  stateDir: string;
}

export interface ImageRef {
  reference: string;
  digest: string;
  id: string;
}

export interface PreparedContainer {
  containerId: string;
  spec: LauncherContainerSpec;
  image: ImageRef;
}

const NO_SANDBOX = "--no-sandbox";

const PREPARING = "preparing pi sandbox, one time";

export const openContext = async (deps: CliDeps): Promise<LaunchContext> => {
  const workspace = await discoverWorkspace(deps.cwd, deps.runner);
  const effective = await loadEffectiveConfig({ repoRoot: workspace.repoRoot, env: deps.env });

  return { workspace, effective, stateDir: pathsOf(deps).stateDir };
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

export const checkWorkspace = (deps: CliDeps, context: LaunchContext) => {
  checkWorkspaceRoots(deps, context);

  assertSafeWorkspace(context.workspace, { home: deps.home, env: deps.env, platform: deps.platform });
};

const fallbackHint = (hint: string | undefined) => {
  const hostPi = "or run pi --no-sandbox to use host pi";

  return hint === undefined ? hostPi : `${hint}; ${hostPi}`;
};

export const openBackend = async (deps: CliDeps, config: SandboxConfig) => {
  try {
    return await selectBackend(config.backend, deps.adapters());
  } catch (error) {
    if (error instanceof LauncherError && config.fallback === "host") {
      throw new LauncherError(error.message, fallbackHint(error.hint));
    }

    throw error;
  }
};

const currentImage = async (backend: Backend, context: LaunchContext) => {
  const { config } = context.effective;
  const record = await recordedImage(context.stateDir, config);

  if (record === undefined) {
    return undefined;
  }

  const container = await findCurrentContainer(backend, context.workspace, record.digest, configHash(config));

  return container === undefined
    ? undefined
    : { reference: record.reference, digest: record.digest, id: record.id };
};

const buildImage = async (deps: CliDeps, context: LaunchContext, backend: Backend): Promise<ImageRef> => {
  const { config } = context.effective;

  writeLine(deps.stderr, PREPARING);

  const extensions =
    config.image.digest === undefined
      ? await resolveExtensionsSource({
          launcherRoot: launcherRoot(),
          runner: deps.runner,
          stateDir: context.stateDir,
        })
      : { kind: "none" as const };
  const image = await ensureBuiltImage({
    backend,
    config,
    versions: { pi: await piVersion(), extensions },
    stateDir: context.stateDir,
  });

  return { reference: image.reference, digest: image.digest, id: image.id };
};

export const prepareImage = async (deps: CliDeps, context: LaunchContext, backend: Backend) =>
  (await currentImage(backend, context)) ?? (await buildImage(deps, context, backend));

export const needsProxy = (config: SandboxConfig) =>
  config.gateway !== undefined || config.egress.allow.length > 0 || config.egress.mcpHosts.length > 0;

export const startProxy = async (deps: CliDeps, context: LaunchContext) => {
  try {
    return await deps.proxy.ensure({
      config: context.effective.config,
      stateDir: context.stateDir,
      env: deps.env,
      home: deps.home,
    });
  } catch (error) {
    throw new LauncherError(
      `the egress proxy could not start, refusing to run without it: ${errorMessage(error)}`,
      error instanceof LauncherError && error.hint !== undefined ? error.hint : "run pi sandbox doctor",
    );
  }
};

const sandboxProxy = async (deps: CliDeps, context: LaunchContext, backend: Backend, imageId: string) => {
  const { config } = context.effective;

  if (!needsProxy(config)) {
    return undefined;
  }

  const instance = await startProxy(deps, context);
  const route: ProxyRoute = await backend.prepareProxyRoute(instance.port, instance.policyHash, imageId);
  const ca = config.gateway === undefined ? undefined : await deps.proxy.ensureCa(context.stateDir);

  return {
    url: guestProxyUrl(route, instance.token),
    network: route.network,
    policyHash: instance.policyHash,
    caPemPath: ca?.certPemPath,
  };
};

export const prepareContainer = async (
  deps: CliDeps,
  context: LaunchContext,
  backend: Backend,
  resolved?: ImageRef,
): Promise<PreparedContainer> => {
  const image = resolved ?? (await prepareImage(deps, context, backend));
  const proxy = await sandboxProxy(deps, context, backend, image.id);
  const spec = buildContainerSpec({
    workspace: context.workspace,
    config: context.effective.config,
    image,
    hostEnv: deps.env,
    hostUid: deps.uid,
    hostGid: deps.gid,
    platform: deps.platform,
    capabilities: backend.capabilities,
    stateDir: context.stateDir,
    gitOverlay: await discoverGitOverlay(context.workspace, deps.runner, deps.home),
    proxy,
    launcherVersion: await launcherVersion(),
    configHash: configHash(context.effective.config),
  });
  const { id } = await ensureContainer({ backend, spec });

  return { containerId: id, spec, image };
};

const runHostPi = async (deps: CliDeps, context: LaunchContext, piArgs: string[]) => {
  const { config, sources } = context.effective;

  if (config.fallback === "refuse") {
    throw new LauncherError(
      `${NO_SANDBOX} is refused: fallback is "refuse", set by ${sources.fallback ?? "default"}`,
      "run pi without --no-sandbox",
    );
  }

  const hostPi = await findHostPi(deps.env);

  if (hostPi === undefined) {
    throw new LauncherError(
      `${NO_SANDBOX}: no host pi found on PATH`,
      "install pi on the host with npm install -g @earendil-works/pi-coding-agent",
    );
  }

  writeLine(deps.stderr, `pi-sandbox: warning: running ${hostPi} on the host, outside the sandbox`);

  return deps.runner.spawnInteractive(hostPi, piArgs, { cwd: deps.cwd });
};

export const launch = async (args: string[], deps: CliDeps) => {
  const piArgs = args.filter((arg) => arg !== NO_SANDBOX);
  const context = await openContext(deps);

  if (piArgs.length !== args.length) {
    checkWorkspaceRoots(deps, context);

    return runHostPi(deps, context, piArgs);
  }

  checkWorkspace(deps, context);

  const backend = await openBackend(deps, context.effective.config);
  const { containerId } = await prepareContainer(deps, context, backend);

  return runPi({
    backend,
    containerId,
    piArgs,
    env: forwardedEnv(context.effective.config.env.allow, deps.env),
    workspace: context.workspace,
    terminal: deps.terminal,
    signals: deps.signals,
  });
};
