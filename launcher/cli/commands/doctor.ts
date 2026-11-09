import { ENGINE_PROFILE, type VmSize } from "../../backend/index.ts";
import { LABELS } from "../../container/index.ts";
import { errorMessage } from "../../shared/index.ts";
import { type CliDeps, writeLine } from "../deps.ts";
import {
  type LaunchContext,
  openContext,
  type Sandbox,
  type Stage,
  type StageOutcome,
  vmPathsOf,
  withSandbox,
} from "../launch.ts";
import type { SandboxProxy } from "../sandbox-proxy.ts";
import { hostChecks } from "./doctor-host.ts";
import {
  answersHealth,
  type CheckResult,
  checkMcp,
  checkMcpAuthSweep,
  checkNoRoute,
  checkOffline,
  checkRules,
  checkSamePath,
  checkSessionsShare,
  checkSettingsSweep,
  failed,
  type ProbeTarget,
  passed,
  skipped,
  sweepCredentials,
  warned,
} from "./doctor-probes.ts";

const attempt = async (action: () => Promise<CheckResult>) => {
  try {
    return await action();
  } catch (error) {
    return failed(errorMessage(error));
  }
};

const print = (deps: CliDeps, name: string, result: CheckResult) => {
  writeLine(deps.stdout, `${result.status} ${name}: ${result.detail}`);

  return result.status !== "fail";
};

const printStage = (deps: CliDeps, stage: Stage, outcome: StageOutcome) => {
  if (!outcome.ok) {
    writeLine(deps.stdout, `fail ${stage}: ${errorMessage(outcome.error)}`);

    return;
  }

  writeLine(deps.stdout, outcome.detail === undefined ? `ok ${stage}` : `ok ${stage}: ${outcome.detail}`);
};

const proxyHealth = async (proxy: SandboxProxy | undefined) => {
  if (proxy === undefined) {
    return skipped("no proxy is required");
  }

  return (await answersHealth(proxy.proxy.port, proxy.token))
    ? passed("/healthz answers")
    : failed("/healthz does not answer");
};

const sessionsShareCheck = async (target: ProbeTarget) => {
  const containers = await target.backend.findContainers({ [LABELS.managed]: "true" });
  const container = containers.find((candidate) => candidate.id === target.containerId);

  return checkSessionsShare(target, container?.labels[LABELS.sessionDir]);
};

const sharesCheck = async (deps: CliDeps, context: LaunchContext, sandbox: Sandbox) => {
  const coverage = await sandbox.backend.vm.coverage(vmPathsOf(deps, context));

  if (coverage === undefined) {
    return skipped(`colima did not report the shares of profile ${ENGINE_PROFILE}`);
  }

  const { shares, missing } = coverage;

  return missing.length === 0
    ? passed(
        `profile ${ENGINE_PROFILE} shares ${shares.map((share) => share.location).join(", ")}; this repository is covered`,
      )
    : failed(
        `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not shared with profile ${ENGINE_PROFILE}`,
      );
};

const gibText = (gib: number) => `${Math.round(gib * 10) / 10} GiB`;

const isBelow = (size: VmSize, recommended: VmSize) =>
  size.cpus < recommended.cpus || size.memoryGiB < recommended.memoryGiB;

const sizeCheck = async (deps: CliDeps, sandbox: Sandbox) => {
  const { vm } = sandbox.backend;
  const size = await vm.size();

  if (size === undefined) {
    return skipped(`colima did not report the size of profile ${ENGINE_PROFILE}`);
  }

  const recommended = vm.recommendedSize(deps.machine.cpus, deps.machine.memoryGiB);
  const current = `profile ${ENGINE_PROFILE} has ${size.cpus} CPUs and ${gibText(size.memoryGiB)}`;

  if (!isBelow(size, recommended)) {
    return passed(current);
  }

  const resize = `colima stop --profile ${ENGINE_PROFILE} && colima start --profile ${ENGINE_PROFILE} --activate=false --cpu ${recommended.cpus} --memory ${recommended.memoryGiB}`;

  return warned(
    `${current}, below ${recommended.cpus} CPUs and ${recommended.memoryGiB} GiB; resize it with ${resize}`,
  );
};

const probe = async (deps: CliDeps, context: LaunchContext, sandbox: Sandbox) => {
  const target = {
    backend: sandbox.backend,
    containerId: sandbox.containerId,
    workdir: sandbox.spec.workdir,
  };
  const rules = await checkRules(target, sandbox.host.derived.rules).catch((error: unknown) => [
    { name: "trust", result: failed(errorMessage(error)) },
  ]);
  const results = [
    print(deps, "proxy health", await attempt(() => proxyHealth(sandbox.proxy))),
    print(deps, "same-path mount", await attempt(() => checkSamePath(target, context.workspace.repoRoot))),
    print(deps, "credential sweep", await attempt(() => sweepCredentials(target))),
    print(deps, "no-route", await attempt(() => checkNoRoute(target))),
    print(deps, "offline", await attempt(() => checkOffline(target))),
    print(deps, "mcp", await attempt(() => checkMcp(target))),
    print(deps, "mcp-auth sweep", await attempt(() => checkMcpAuthSweep(target))),
    print(deps, "settings sweep", await attempt(() => checkSettingsSweep(target))),
    print(deps, "sessions share", await attempt(() => sessionsShareCheck(target))),
    ...rules.map((check) => print(deps, check.name, check.result)),
    print(deps, "vm shares", await attempt(() => sharesCheck(deps, context, sandbox))),
    print(deps, "vm size", await attempt(() => sizeCheck(deps, sandbox))),
  ];

  return results.every(Boolean) ? 0 : 1;
};

export const doctorCommand = async (deps: CliDeps) => {
  const { context, backend } = await openContext(deps, "sandbox");
  const failures: Stage[] = [];
  const report = (stage: Stage, outcome: StageOutcome) => {
    if (!outcome.ok) {
      failures.push(stage);
    }

    printStage(deps, stage, outcome);
  };
  const code = await withSandbox(deps, context, backend, (sandbox) => probe(deps, context, sandbox), {
    report,
  }).catch((error: unknown) => {
    if (failures.length === 0) {
      throw error;
    }

    return 1;
  });
  const host = (await hostChecks(deps, context)).map((check) => print(deps, check.name, check.result));

  if (code !== 0) {
    return code;
  }

  return failures.length === 0 && host.every(Boolean) ? 0 : 1;
};
