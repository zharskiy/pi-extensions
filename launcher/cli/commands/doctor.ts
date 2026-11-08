import type { Backend } from "../../backend/index.ts";
import {
  answersHealth,
  type CheckResult,
  checkNoRoute,
  checkSamePath,
  failed,
  LABELS,
  type ProbeTarget,
  passed,
  removeRepoContainer,
  skipped,
  sweepCredentials,
} from "../../container/index.ts";
import { errorMessage } from "../../shared/index.ts";
import type { HostSessions } from "../../workspace/index.ts";
import { type CliDeps, writeLine } from "../deps.ts";
import { type HostSide, prepareHostSide } from "../derive.ts";
import { resolveJobPi } from "../host-pi.ts";
import { hostSessionsOf, sessionsSweeper } from "../host-sessions.ts";
import {
  checkWorkspace,
  type LaunchContext,
  openBackend,
  openContext,
  type PreparedContainer,
  prepareContainer,
  prepareImage,
} from "../launch.ts";
import { openSandboxProxy, type SandboxProxy } from "../sandbox-proxy.ts";
import { beginSession, finishSession, type LaunchSession, othersLive } from "../sessions.ts";
import {
  checkBrowserShim,
  checkMcp,
  checkMcpAuthSweep,
  checkOffline,
  checkRules,
  checkSessionsShare,
  checkSettingsSweep,
  type NamedCheck,
} from "./doctor-container.ts";
import { hostChecks } from "./doctor-host.ts";

const CONTAINER_CHECKS = [
  "same-path mount",
  "credential sweep",
  "no-route",
  "offline",
  "mcp",
  "mcp-auth sweep",
  "settings sweep",
  "browser",
  "sessions share",
  "trust",
];

const attempt = async (action: () => Promise<CheckResult>) => {
  try {
    return await action();
  } catch (error) {
    return failed(errorMessage(error));
  }
};

const report = (deps: CliDeps, name: string, result: CheckResult) => {
  writeLine(deps.stdout, `${result.status} ${name}: ${result.detail}`);

  return result.status !== "fail";
};

const reportAll = (deps: CliDeps, checks: NamedCheck[]) =>
  checks.map((check) => report(deps, check.name, check.result));

const skipAll = (deps: CliDeps, names: string[], reason: string) =>
  names.map((name) => report(deps, name, skipped(reason)));

const proxyCheck = async (proxy: SandboxProxy | undefined) => {
  if (proxy === undefined) {
    return passed("not required, no gateway, no credential rule and an empty allowlist");
  }

  const where = `pid ${proxy.instance.pid} port ${proxy.instance.port}`;

  return (await answersHealth(proxy.instance.port, proxy.repoToken))
    ? passed(`${where}, /healthz answers`)
    : failed(`${where}, /healthz does not answer`);
};

const browserCheck = (proxy: SandboxProxy | undefined, target: ProbeTarget) =>
  proxy === undefined
    ? Promise.resolve(skipped("no proxy, nothing to open a sign-in through"))
    : checkBrowserShim(target);

const sessionsShareCheck = async (target: ProbeTarget) => {
  const containers = await target.backend.findContainers({ [LABELS.managed]: "true" });
  const container = containers.find((candidate) => candidate.id === target.containerId);

  return checkSessionsShare(target, container?.labels[LABELS.sessionDir]);
};

const containerChecks = async (
  deps: CliDeps,
  context: LaunchContext,
  parts: { host: HostSide; proxy?: SandboxProxy },
  target: ProbeTarget,
) => {
  const { host, proxy } = parts;
  const placeholder = context.effective.config.gateway?.placeholder;
  const rules = await checkRules(target, host.derived.rules).catch((error: unknown) => [
    { name: "trust", result: failed(errorMessage(error)) },
  ]);

  return [
    report(deps, "same-path mount", await attempt(() => checkSamePath(target, context.workspace.repoRoot))),
    report(deps, "credential sweep", await attempt(() => sweepCredentials(target, placeholder))),
    report(deps, "no-route", await attempt(() => checkNoRoute(target))),
    report(deps, "offline", await attempt(() => checkOffline(target))),
    report(deps, "mcp", await attempt(() => checkMcp(target))),
    report(deps, "mcp-auth sweep", await attempt(() => checkMcpAuthSweep(target))),
    report(deps, "settings sweep", await attempt(() => checkSettingsSweep(target))),
    report(deps, "browser", await attempt(() => browserCheck(proxy, target))),
    report(deps, "sessions share", await attempt(() => sessionsShareCheck(target))),
    ...reportAll(deps, rules),
  ];
};

const startedProxy = (deps: CliDeps, context: LaunchContext, host: HostSide) =>
  openSandboxProxy(deps, context, host).catch((error: unknown) => errorMessage(error));

interface Containers {
  created?: PreparedContainer;
}

const imageAndContainer = async (
  deps: CliDeps,
  context: LaunchContext,
  backend: Backend,
  parts: { host: HostSide; proxy?: SandboxProxy; session: LaunchSession; sessions: HostSessions },
  containers: Containers,
) => {
  const image = await prepareImage(deps, context, backend, parts.host).catch((error: unknown) =>
    errorMessage(error),
  );

  if (typeof image === "string") {
    return [report(deps, "image", failed(image)), ...skipAll(deps, CONTAINER_CHECKS, "no image")];
  }

  report(deps, "image", passed(`${image.reference} ${image.digest}`));

  const prepared = await prepareContainer(deps, context, backend, { ...parts, image }).catch(
    (error: unknown) => errorMessage(error),
  );

  if (typeof prepared === "string") {
    return [report(deps, "container", failed(prepared)), ...skipAll(deps, CONTAINER_CHECKS, "no container")];
  }

  containers.created = prepared.created ? prepared : undefined;

  const target = { backend, containerId: prepared.containerId, workdir: prepared.spec.workdir };

  return containerChecks(deps, context, parts, target);
};

const sandboxChecks = async (
  deps: CliDeps,
  context: LaunchContext,
  backend: Backend,
  host: HostSide,
  session: LaunchSession,
  sessions: HostSessions,
) => {
  const proxy = await startedProxy(deps, context, host);

  if (typeof proxy === "string") {
    return [
      report(deps, "proxy", failed(proxy)),
      ...skipAll(deps, ["image", ...CONTAINER_CHECKS], "no proxy"),
    ];
  }

  const proxyOk = report(deps, "proxy", await attempt(() => proxyCheck(proxy)));
  const containers: Containers = {};

  try {
    return [
      proxyOk,
      ...(await imageAndContainer(deps, context, backend, { host, proxy, session, sessions }, containers)),
    ];
  } finally {
    if (
      containers.created !== undefined &&
      !(await othersLive(context.stateDir, context.repoHash, session.launchId))
    ) {
      await removeRepoContainer(backend, context.workspace.repoRoot);
    }
  }
};

const backendChecks = async (deps: CliDeps, context: LaunchContext, backend: Backend) => {
  const host = await prepareHostSide(deps, context, await resolveJobPi(deps)).catch((error: unknown) =>
    errorMessage(error),
  );

  if (typeof host === "string") {
    return [
      report(deps, "host pi files", failed(host)),
      ...skipAll(deps, ["proxy", "image", ...CONTAINER_CHECKS], "no host files"),
    ];
  }

  const sessions = hostSessionsOf(deps, context, host.files.settings);
  const session = await beginSession(deps, context);

  try {
    return await sandboxChecks(deps, context, backend, host, session, sessions);
  } finally {
    await finishSession(deps, context, backend, session, sessionsSweeper(deps, context));
  }
};

export const doctorCommand = async (deps: CliDeps) => {
  const context = await openContext(deps);

  checkWorkspace(deps, context);

  const backend = await openBackend(deps, context.effective.config).catch((error: unknown) =>
    errorMessage(error),
  );

  if (typeof backend === "string") {
    report(deps, "runtime", failed(backend));

    skipAll(deps, ["proxy", "image", ...CONTAINER_CHECKS], "no runtime");

    reportAll(deps, await hostChecks(deps, context));

    return 1;
  }

  const detection = await backend.detect();

  report(deps, "runtime", passed(`colima ${detection.version ?? "unknown"}`));

  const results = await backendChecks(deps, context, backend);
  const host = reportAll(deps, await hostChecks(deps, context, backend));

  return [...results, ...host].every(Boolean) ? 0 : 1;
};
