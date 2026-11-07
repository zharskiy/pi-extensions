import type { Backend } from "../../backend/index.ts";
import {
  answersHealth,
  type CheckResult,
  checkNoRoute,
  checkSamePath,
  failed,
  type ProbeTarget,
  passed,
  removeRepoContainer,
  skipped,
  sweepCredentials,
} from "../../container/index.ts";
import { errorMessage } from "../../shared/index.ts";
import { type CliDeps, writeLine } from "../deps.ts";
import { type HostSide, prepareHostSide } from "../derive.ts";
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
import { beginSession, finishSession } from "../sessions.ts";
import { checkMcp, checkOffline, checkRules, type NamedCheck } from "./doctor-container.ts";
import { hostChecks } from "./doctor-host.ts";

const CONTAINER_CHECKS = ["same-path mount", "credential sweep", "no-route", "offline", "mcp", "trust"];

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

const containerChecks = async (
  deps: CliDeps,
  context: LaunchContext,
  host: HostSide,
  target: ProbeTarget,
) => {
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
  parts: { host: HostSide; proxy?: SandboxProxy },
  containers: Containers,
) => {
  const image = await prepareImage(deps, context, backend, parts.host.trust).catch((error: unknown) =>
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

  return containerChecks(deps, context, parts.host, target);
};

const sandboxChecks = async (deps: CliDeps, context: LaunchContext, backend: Backend, host: HostSide) => {
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
    return [proxyOk, ...(await imageAndContainer(deps, context, backend, { host, proxy }, containers))];
  } finally {
    if (containers.created !== undefined) {
      await removeRepoContainer(backend, context.workspace.repoRoot);
    }
  }
};

const backendChecks = async (deps: CliDeps, context: LaunchContext, backend: Backend) => {
  const host = await prepareHostSide(deps, context).catch((error: unknown) => errorMessage(error));

  if (typeof host === "string") {
    return [
      report(deps, "host pi files", failed(host)),
      ...skipAll(deps, ["proxy", "image", ...CONTAINER_CHECKS], "no host files"),
    ];
  }

  const session = await beginSession(deps, context, host.repoHash);

  try {
    return await sandboxChecks(deps, context, backend, host);
  } finally {
    await finishSession(deps, context, backend, session);
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

  report(deps, "runtime", passed(`${backend.name} ${detection.version ?? "unknown"}`));

  const results = await backendChecks(deps, context, backend);
  const host = reportAll(deps, await hostChecks(deps, context));

  return [...results, ...host].every(Boolean) ? 0 : 1;
};
