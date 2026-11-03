import type { Backend } from "../../backend/index.ts";
import {
  answersHealth,
  type CheckResult,
  checkNoRoute,
  checkSamePath,
  failed,
  type ProbeTarget,
  passed,
  skipped,
  sweepCredentials,
} from "../../container/index.ts";
import { errorMessage } from "../../shared/index.ts";
import { type CliDeps, writeLine } from "../deps.ts";
import {
  checkWorkspace,
  type LaunchContext,
  needsProxy,
  openBackend,
  openContext,
  prepareContainer,
  prepareImage,
  startProxy,
} from "../launch.ts";

const CONTAINER_CHECKS = ["same-path mount", "credential sweep", "no-route"];

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

const skipAll = (deps: CliDeps, names: string[], reason: string) =>
  names.map((name) => report(deps, name, skipped(reason)));

const checkProxy = async (deps: CliDeps, context: LaunchContext) => {
  if (!needsProxy(context.effective.config)) {
    return passed("not required, no gateway and an empty allowlist");
  }

  const proxy = await startProxy(deps, context);
  const where = `pid ${proxy.pid} port ${proxy.port}`;

  return (await answersHealth(proxy.port, proxy.token))
    ? passed(`${where}, /healthz answers`)
    : failed(`${where}, /healthz does not answer`);
};

const containerChecks = async (deps: CliDeps, context: LaunchContext, target: ProbeTarget) => [
  report(deps, "same-path mount", await attempt(() => checkSamePath(target, context.workspace.repoRoot))),
  report(
    deps,
    "credential sweep",
    await attempt(() => sweepCredentials(target, context.effective.config.gateway?.placeholder)),
  ),
  report(deps, "no-route", await attempt(() => checkNoRoute(target))),
];

const sandboxChecks = async (deps: CliDeps, context: LaunchContext, backend: Backend) => {
  const proxyOk = report(deps, "proxy", await attempt(() => checkProxy(deps, context)));
  const image = await prepareImage(deps, context, backend).catch((error: unknown) => errorMessage(error));

  if (typeof image === "string") {
    return [proxyOk, report(deps, "image", failed(image)), ...skipAll(deps, CONTAINER_CHECKS, "no image")];
  }

  report(deps, "image", passed(`${image.reference} ${image.digest}`));

  const prepared = await prepareContainer(deps, context, backend, image).catch((error: unknown) =>
    errorMessage(error),
  );

  if (typeof prepared === "string") {
    return [
      proxyOk,
      report(deps, "container", failed(prepared)),
      ...skipAll(deps, CONTAINER_CHECKS, "no container"),
    ];
  }

  const target = { backend, containerId: prepared.containerId, workdir: prepared.spec.workdir };

  return [proxyOk, ...(await containerChecks(deps, context, target))];
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

    return 1;
  }

  const detection = await backend.detect();

  report(deps, "runtime", passed(`${backend.name} ${detection.version ?? "unknown"}`));

  const results = await sandboxChecks(deps, context, backend);

  return results.every(Boolean) ? 0 : 1;
};
