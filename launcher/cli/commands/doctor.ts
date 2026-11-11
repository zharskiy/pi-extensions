import { type Backend, ENGINE_PROFILE, LABELS, recommendedVmSize, type VmSize } from "../../backend/index.ts";
import { authorityOf, type CredentialRule } from "../../config/index.ts";
import { readHostPiFiles } from "../../hostpi/index.ts";
import { type DenialRecord, readHealth } from "../../proxy/index.ts";
import { errorMessage } from "../../shared/index.ts";
import { type LaunchContext, openContext } from "../context.ts";
import { type CliDeps, hostAgentDirOf, writeLine } from "../deps.ts";
import { hostSessionsOf } from "../host-sessions.ts";
import { type Sandbox, type Stage, type StageOutcome, withSandbox } from "../launch.ts";
import { denialHint, ruleAuthority, type SandboxProxy } from "../sandbox-proxy.ts";
import { vmShareCoverage } from "../vm.ts";
import { hostChecks } from "./doctor-host.ts";
import {
  type CheckResult,
  checkMcp,
  checkMcpAuthSweep,
  checkNoRoute,
  checkRules,
  checkSessionsShare,
  checkSettingsSweep,
  failed,
  type NamedCheck,
  type ProbeTarget,
  passed,
  type RuleHint,
  skipped,
  sweepCredentials,
  warned,
} from "./doctor-probes.ts";

interface ProbeInput {
  deps: CliDeps;
  context: LaunchContext;
  sandbox: Sandbox;
  target: ProbeTarget;
}

type Probe = (input: ProbeInput) => Promise<NamedCheck[]>;

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

  return (await readHealth(proxy.proxy.port, proxy.token)) !== undefined
    ? passed("/healthz answers")
    : failed("/healthz does not answer");
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

  const recommended = recommendedVmSize(deps.machine.cpus, deps.machine.memoryGiB);
  const current = `profile ${ENGINE_PROFILE} has ${size.cpus} CPUs and ${gibText(size.memoryGiB)}`;

  return isBelow(size, recommended)
    ? warned(
        `${current}, below ${recommended.cpus} CPUs and ${recommended.memoryGiB} GiB; resize it with ${vm.resizeCommand(recommended)}`,
      )
    : passed(current);
};

interface SharesOutcome {
  result: CheckResult;
  missing: string[];
}

const sharesCheck = async (
  deps: CliDeps,
  context: LaunchContext,
  backend: Backend,
): Promise<SharesOutcome> => {
  const files = await readHostPiFiles(hostAgentDirOf(deps)).catch(() => undefined);
  const coverage = await vmShareCoverage(
    deps,
    context,
    backend,
    hostSessionsOf(deps, context, files?.settings),
  );

  if (coverage === undefined) {
    return {
      result: skipped(`colima has not written the shares of profile ${ENGINE_PROFILE} yet`),
      missing: [],
    };
  }

  return {
    result:
      coverage.missing.length === 0
        ? passed("the sandbox VM shares every path this repository needs")
        : warned(
            `the sandbox VM does not share ${coverage.missing.join(", ")}; the next pi here shares it, restarting the VM once no pi session runs`,
          ),
    missing: coverage.missing,
  };
};

const sharesOf = (deps: CliDeps, context: LaunchContext, backend: Backend) =>
  sharesCheck(deps, context, backend).catch((error: unknown) => ({
    result: failed(errorMessage(error)),
    missing: [],
  }));

const single =
  (name: string, check: (input: ProbeInput) => Promise<CheckResult>): Probe =>
  async (input) => [{ name, result: await attempt(() => check(input)) }];

const inOrder =
  (...probes: Probe[]): Probe =>
  (input) =>
    probes.reduce<Promise<NamedCheck[]>>(
      async (done, probe) => [...(await done), ...(await probe(input))],
      Promise.resolve([]),
    );

const isRefusalOf = (rule: CredentialRule) => {
  const authority = ruleAuthority(rule);

  return (denial: DenialRecord) =>
    denial.credentialRule === undefined && authorityOf(denial.host, denial.port) === authority;
};

const ruleHints =
  ({ deps, context, sandbox }: ProbeInput, rules: CredentialRule[]) =>
  async (): Promise<ReadonlyMap<string, RuleHint>> => {
    const denials =
      sandbox.proxy === undefined
        ? []
        : await deps.proxy
            .denials(context.stateDir, context.repoHash, sandbox.launch.startedAt)
            .catch(() => []);
    const hint = (denial: DenialRecord) =>
      denialHint(deps, denial, authorityOf(denial.host, denial.port), context);

    return new Map(
      rules.map((rule): [string, RuleHint] => {
        const unresolved = denials.findLast((denial) => denial.credentialRule === rule.id);
        const refused = denials.findLast(isRefusalOf(rule));

        return [
          rule.id,
          {
            ...(unresolved === undefined ? {} : { unresolved: hint(unresolved) }),
            ...(refused === undefined ? {} : { refused: hint(refused) }),
          },
        ];
      }),
    );
  };

const ruleChecks: Probe = (input) => {
  const { rules } = input.sandbox.host.derived;

  return checkRules(input.target, rules, ruleHints(input, rules)).catch((error: unknown) => [
    { name: "trust", result: failed(errorMessage(error)) },
  ]);
};

const sessionsShareCheck = async (target: ProbeTarget) => {
  const containers = await target.backend.findContainers({ [LABELS.managed]: "true" });
  const running = containers.find((container) => container.id === target.containerId);

  return checkSessionsShare(target, running?.labels[LABELS.sessionDir]);
};

const PROBES: Probe[] = [
  single("proxy health", ({ sandbox }) => proxyHealth(sandbox.proxy)),
  single("credential sweep", ({ target, sandbox }) => sweepCredentials(target, sandbox.proxy?.token)),
  single("no-route", ({ target }) => checkNoRoute(target)),
  inOrder(
    single("mcp", ({ target }) => checkMcp(target)),
    single("mcp-auth sweep", ({ target }) => checkMcpAuthSweep(target)),
    single("settings sweep", ({ target }) => checkSettingsSweep(target)),
  ),
  single("sessions share", ({ target }) => sessionsShareCheck(target)),
  ruleChecks,
  single("vm size", ({ deps, sandbox }) => sizeCheck(deps, sandbox)),
];

const probe = async (deps: CliDeps, context: LaunchContext, sandbox: Sandbox) => {
  const target = {
    backend: sandbox.backend,
    containerId: sandbox.containerId,
    workdir: sandbox.spec.workdir,
  };
  const checks = (await Promise.all(PROBES.map((run) => run({ deps, context, sandbox, target })))).flat();
  const results = checks.map((check) => print(deps, check.name, check.result));

  return results.every(Boolean) ? 0 : 1;
};

const sandboxChecks = async (deps: CliDeps, context: LaunchContext, backend: Backend) => {
  const failures: Stage[] = [];
  const report = (stage: Stage, outcome: StageOutcome) => {
    if (!outcome.ok) {
      failures.push(stage);
    }

    printStage(deps, stage, outcome);
  };
  const code = await withSandbox(deps, context, backend, (sandbox) => probe(deps, context, sandbox), {
    report,
    signIn: false,
    share: false,
    ruleDenials: false,
  }).catch((error: unknown) => {
    if (failures.length === 0) {
      throw error;
    }

    return 1;
  });

  return code === 0 && failures.length === 0 ? 0 : code || 1;
};

const skipSandbox = (deps: CliDeps, missing: string[]) => {
  writeLine(
    deps.stdout,
    `skip sandbox: run pi once here to share ${missing.join(", ")}, then pi sandbox doctor again`,
  );

  return 0;
};

export const doctorCommand = async (deps: CliDeps) => {
  const { context, backend } = await openContext(deps, "sandbox");
  const shares = await sharesOf(deps, context, backend);
  const code =
    shares.missing.length === 0
      ? await sandboxChecks(deps, context, backend)
      : skipSandbox(deps, shares.missing);
  const host = [
    print(deps, "vm shares", shares.result),
    ...(await hostChecks(deps, context)).map((check) => print(deps, check.name, check.result)),
  ];

  if (code !== 0) {
    return code;
  }

  return host.every(Boolean) ? 0 : 1;
};
