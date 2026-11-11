import { type Backend, ENGINE_PROFILE, LABELS, recommendedVmSize, type VmSize } from "../../backend/index.ts";
import { authorityOf, type CredentialRule } from "../../config/index.ts";
import { readHostPiFiles } from "../../hostpi/index.ts";
import { type DenialRecord, readHealth } from "../../proxy/index.ts";
import { errorMessage, LauncherError } from "../../shared/index.ts";
import { type LaunchContext, openContext } from "../context.ts";
import { type CliDeps, colorOf, hostAgentDirOf, isTerminal, lineSink, writeLines } from "../deps.ts";
import { missingPiText } from "../host-pi.ts";
import { hostSessionsOf } from "../host-sessions.ts";
import { type Sandbox, type Stage, type StageOutcome, withSandbox } from "../launch.ts";
import {
  denialAdvice,
  deniedTargets,
  explainedBy,
  ruleAuthority,
  type SandboxProxy,
  sandboxDenials,
} from "../sandbox-proxy.ts";
import { vmShareCoverage } from "../vm.ts";
import { hostChecks } from "./doctor-host.ts";
import {
  checkMcp,
  checkMcpAuthSweep,
  checkNoRoute,
  checkRules,
  checkSessionsShare,
  checkSettingsSweep,
  type ProbeTarget,
  type RuleAdvice,
  type RuleHint,
  sweepCredentials,
} from "./doctor-probes.ts";
import {
  type CheckResult,
  failed,
  type NamedCheck,
  passed,
  renderReport,
  type Section,
  skipped,
  VERBOSE_FLAG,
  warned,
} from "./doctor-report.ts";

interface ProbeInput {
  deps: CliDeps;
  context: LaunchContext;
  sandbox: Sandbox;
  target: ProbeTarget;
}

type Probe = (input: ProbeInput) => Promise<NamedCheck[]>;

interface Progress {
  line: (text: string) => void;
  clear: () => void;
}

interface Run {
  checks: NamedCheck[];
  progress: Progress;
}

const NOTICE_PREFIX = "pi-sandbox: ";

const ERASE_LINE = "\r\u001b[2K";

const STAGE_LABEL: Record<Stage, string> = {
  vm: "vm",
  shares: "shares",
  host: "host side",
  proxy: "proxy",
  image: "image",
  container: "container",
  sync: "sync",
};

const STAGE_SECTION: Record<Stage, Section> = {
  vm: "sandbox",
  shares: "sandbox",
  host: "host",
  proxy: "network",
  image: "sandbox",
  container: "sandbox",
  sync: "sandbox",
};

const withoutPrefix = (line: string) =>
  line.startsWith(NOTICE_PREFIX) ? line.slice(NOTICE_PREFIX.length) : line;

const progressLine = (deps: CliDeps): Progress => {
  if (!isTerminal(deps.stderr) || deps.env.TERM === "dumb") {
    return { line: () => undefined, clear: () => undefined };
  }

  const state = { shown: false };
  const width = Math.max(1, deps.terminal.columns - 1);

  return {
    line: (text) => {
      state.shown = true;

      deps.stderr.write(`${ERASE_LINE}${`pi sandbox doctor: ${withoutPrefix(text)}`.slice(0, width)}`);
    },
    clear: () => {
      if (state.shown) {
        state.shown = false;

        deps.stderr.write(ERASE_LINE);
      }
    },
  };
};

const attempt = async (action: () => Promise<CheckResult>) => {
  try {
    return await action();
  } catch (error) {
    return failed(errorMessage(error));
  }
};

const stageResult = (outcome: StageOutcome) => {
  if (outcome.ok) {
    return passed(outcome.detail ?? "");
  }

  return failed(errorMessage(outcome.error), {
    hint: outcome.error instanceof LauncherError ? outcome.error.hint : undefined,
  });
};

const stageCheck = (stage: Stage, outcome: StageOutcome): NamedCheck => ({
  name: STAGE_LABEL[stage],
  section: STAGE_SECTION[stage],
  result: stageResult(outcome),
});

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
    ? warned(`${current}, below ${recommended.cpus} CPUs and ${recommended.memoryGiB} GiB`, {
        hint: `resize it with ${vm.resizeCommand(recommended)}`,
      })
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
        : warned(`the sandbox VM does not share ${coverage.missing.join(", ")}`, {
            hint: "run pi once here while no other pi session runs, which shares it and restarts the VM, then pi sandbox doctor again",
          }),
    missing: coverage.missing,
  };
};

const sharesOf = (deps: CliDeps, context: LaunchContext, backend: Backend) =>
  sharesCheck(deps, context, backend).catch((error: unknown) => ({
    result: failed(errorMessage(error)),
    missing: [],
  }));

const single =
  (name: string, section: Section, check: (input: ProbeInput) => Promise<CheckResult>): Probe =>
  async (input) => [{ name, section, result: await attempt(() => check(input)) }];

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

const adviceOf = (deps: CliDeps, context: LaunchContext) => (denial: DenialRecord) => {
  const advice = denialAdvice(deps, denial, authorityOf(denial.host, denial.port), context);

  return {
    reason: advice.reason ?? denial.reason,
    ...(advice.fix === undefined ? {} : { fix: advice.fix }),
  } satisfies RuleAdvice;
};

const ruleHints =
  ({ deps, context, sandbox }: ProbeInput, rules: CredentialRule[]) =>
  async (): Promise<ReadonlyMap<string, RuleHint>> => {
    const denials =
      sandbox.proxy === undefined ? [] : await sandboxDenials(deps, context, sandbox.launch.startedAt);
    const advice = adviceOf(deps, context);

    return new Map(
      rules.map((rule): [string, RuleHint] => {
        const unresolved = denials.findLast((denial) => denial.credentialRule === rule.id);
        const refused = denials.findLast(isRefusalOf(rule));

        return [
          rule.id,
          {
            ...(unresolved === undefined ? {} : { unresolved: advice(unresolved) }),
            ...(refused === undefined ? {} : { refused: advice(refused) }),
          },
        ];
      }),
    );
  };

const ruleChecks: Probe = (input) => {
  const { rules } = input.sandbox.host.derived;

  return checkRules(input.target, rules, ruleHints(input, rules)).catch((error: unknown) => [
    { name: "trust", section: "credentials", result: failed(errorMessage(error)) },
  ]);
};

const sessionsShareCheck = async (target: ProbeTarget) => {
  const containers = await target.backend.findContainers({ [LABELS.managed]: "true" });
  const running = containers.find((container) => container.id === target.containerId);

  return checkSessionsShare(target, running?.labels[LABELS.sessionDir]);
};

const PROBES: Probe[] = [
  single("proxy health", "network", ({ sandbox }) => proxyHealth(sandbox.proxy)),
  single("credential sweep", "leak sweep", ({ target, sandbox }) =>
    sweepCredentials(target, sandbox.proxy?.token),
  ),
  single("no-route", "network", ({ target }) => checkNoRoute(target)),
  inOrder(
    single("mcp", "network", ({ target }) => checkMcp(target)),
    single("mcp-auth sweep", "leak sweep", ({ target }) => checkMcpAuthSweep(target)),
    single("settings sweep", "leak sweep", ({ target }) => checkSettingsSweep(target)),
  ),
  single("sessions share", "sandbox", ({ target }) => sessionsShareCheck(target)),
  ruleChecks,
  single("vm size", "sandbox", ({ deps, sandbox }) => sizeCheck(deps, sandbox)),
];

const probe = async (deps: CliDeps, context: LaunchContext, sandbox: Sandbox) => {
  const target = {
    backend: sandbox.backend,
    containerId: sandbox.containerId,
    workdir: sandbox.spec.workdir,
  };

  return (await Promise.all(PROBES.map((run) => run({ deps, context, sandbox, target })))).flat();
};

const blockedChecks = (deps: CliDeps, context: LaunchContext, rules: CredentialRule[]) => {
  const explained = explainedBy(rules);
  const advice = adviceOf(deps, context);

  return (denials: DenialRecord[]) =>
    deniedTargets(denials.filter((denial) => !explained(denial))).map((denial): NamedCheck => {
      const { reason, fix } = advice(denial);

      return {
        name: `blocked ${authorityOf(denial.host, denial.port)}`,
        section: "network",
        result: warned(reason, { hint: fix }),
      };
    });
};

const notRun = (stage: Stage | undefined): NamedCheck => ({
  name: "probes",
  section: "sandbox",
  result: skipped(
    stage === undefined
      ? "not run: the preparation was stopped"
      : `not run: the ${STAGE_LABEL[stage]} stage failed`,
  ),
});

const sandboxChecks = async (deps: CliDeps, context: LaunchContext, backend: Backend, run: Run) => {
  const seen: { failed?: Stage; rules?: CredentialRule[] } = {};
  const report = (stage: Stage, outcome: StageOutcome) => {
    seen.failed ??= outcome.ok ? undefined : stage;

    run.checks.push(stageCheck(stage, outcome));

    run.progress.line(`${STAGE_LABEL[stage]} ${outcome.ok ? "ready" : "failed"}`);
  };
  const use = async (sandbox: Sandbox) => {
    seen.rules = sandbox.host.derived.rules;

    run.progress.line("checking inside the sandbox");

    run.checks.push(...(await probe(deps, context, sandbox)));

    return 0;
  };
  const code = await withSandbox(deps, context, backend, use, {
    report,
    progress: run.progress.line,
    signIn: false,
    share: false,
    denials: (records) => run.checks.push(...blockedChecks(deps, context, seen.rules ?? [])(records)),
  }).catch((error: unknown) => {
    if (seen.failed === undefined) {
      throw error;
    }

    return undefined;
  });
  if (seen.rules !== undefined) {
    return undefined;
  }

  run.checks.push(notRun(seen.failed));

  return code;
};

const skipSandbox = (run: Run, missing: string[]) => {
  run.checks.push({
    name: "sandbox",
    section: "sandbox",
    result: skipped(`not started until the VM shares ${missing.join(", ")}`),
  });

  return undefined;
};

const runChecks = async (deps: CliDeps, run: Run) => {
  run.progress.line("preparing the sandbox");

  const { context, backend } = await openContext(deps, "sandbox");
  const shares = await sharesOf(deps, context, backend);

  run.checks.push({ name: "vm shares", section: "sandbox", result: shares.result });

  const signal =
    shares.missing.length === 0
      ? await sandboxChecks(deps, context, backend, run)
      : skipSandbox(run, shares.missing);

  run.progress.line("checking the host");

  run.checks.push(...(await hostChecks(deps, context)));

  return signal;
};

const noticesOf = (deps: CliDeps, lines: string[]) =>
  [...new Set(lines.map(withoutPrefix))].filter((notice) => notice !== missingPiText(deps));

export const doctorCommand = async (deps: CliDeps, args: string[]) => {
  const run: Run = { checks: [], progress: progressLine(deps) };
  const notices: string[] = [];
  const quiet: CliDeps = { ...deps, stderr: lineSink((line) => notices.push(line)) };
  const report = (partial: boolean) => {
    run.progress.clear();

    writeLines(
      deps.stdout,
      renderReport(run.checks, noticesOf(deps, notices), {
        verbose: args.includes(VERBOSE_FLAG),
        color: colorOf(deps),
        home: deps.home,
        partial,
      }),
    );
  };

  try {
    const signal = await runChecks(quiet, run);

    report(false);

    return signal ?? (run.checks.some((check) => check.result.status === "fail") ? 1 : 0);
  } catch (error) {
    run.progress.clear();

    if (run.checks.length > 0 || notices.length > 0) {
      report(true);
    }

    throw error;
  }
};
