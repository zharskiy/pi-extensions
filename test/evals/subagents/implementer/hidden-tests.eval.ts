import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { it } from "vitest";
import type { AgentRecord } from "../../../../extensions/subagents/tests/support/agent-records.ts";
import {
  createLiveHarness,
  type LiveHarness,
} from "../../../../extensions/subagents/tests/support/live-harness.ts";
import { formatDuration } from "../../../../platform/shared/index.ts";
import {
  evalRunCount,
  expectPassRate,
  gradeRun,
  gradeRuns,
  MAJORITY,
  type Rubric,
  type RunRecord,
  repeatRuns,
  reportEval,
  reportRun,
} from "../../../framework/eval-runs/index.ts";
import { largestToolOutput, repoGit } from "../../../framework/index.ts";
import { sessionFacts } from "../../../framework/pi/index.ts";
import { describeLive } from "../../../framework/pi/live/index.ts";
import {
  chainRecord,
  failureSuffix,
  handoverLines,
  helperCounts,
  runChain,
} from "../support/agent-chains.ts";
import { type ImplementerCase, implementerCases } from "./implementer-cases.ts";

type Outcome = {
  status: string;
  passed: boolean;
  tests: string;
  helpers: string[];
  handover: string[];
  calls: number;
  cost: number;
  durationMs: number;
  failure: string | undefined;
  largestBash: number;
  record: RunRecord;
};

const RUN_TIMEOUT_MS = 420_000;

const TEST_TIMEOUT_MS = 120_000;

const SUMMARY = /Tests\s+(.*?\(\d+\))/;

const execFileAsync = promisify(execFile);

type ExecFailure = { stdout?: string; stderr?: string; code?: number | string; signal?: string };

const RESULTS_ENV = "PI_EVAL_RESULTS";

const childEnv = () =>
  Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== RESULTS_ENV));

const hiddenTests = async (live: LiveHarness, entry: ImplementerCase) => {
  entry.tests.forEach((file) => {
    writeFileSync(join(live.project, file), repoGit(["show", `${entry.sha}:${file}`]));
  });

  const options = {
    cwd: live.project,
    encoding: "utf8" as const,
    timeout: TEST_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...childEnv(), NO_COLOR: "1", FORCE_COLOR: "0" },
  };

  return execFileAsync("npx", ["vitest", "run", ...entry.tests], options).then(
    ({ stdout, stderr }) => ({ passed: true, tests: SUMMARY.exec(`${stdout}${stderr}`)?.[1] ?? "exit 0" }),
    (error: ExecFailure) => ({
      passed: false,
      tests:
        SUMMARY.exec(`${error.stdout ?? ""}${error.stderr ?? ""}`)?.[1] ??
        `exit ${error.code ?? error.signal}`,
    }),
  );
};

const largestBashOf = (links: AgentRecord[]) =>
  links.reduce((max, link) => {
    const outputs = link.sessionFile ? sessionFacts(link.sessionFile).results : [];

    return Math.max(max, largestToolOutput(outputs, "bash"));
  }, 0);

const implementOnce = async (entry: ImplementerCase, index: number): Promise<Outcome> => {
  const label = `implement ${entry.sha} run ${index + 1}`;
  const live = createLiveHarness(label, {
    agents: {
      implementer: { from: "implementer", fields: { limit: "120000" } },
      scout: { from: "scout" },
      shell: { from: "shell" },
      verifier: { from: "verifier" },
    },
  });

  try {
    live.seed(`${entry.sha}^`);

    const chain = await runChain(live, "implementer", entry.task, RUN_TIMEOUT_MS);
    const largestBash = largestBashOf(chain.links);
    const status = chain.timedOut ? "timeout" : (chain.terminal?.state ?? "missing");
    const hidden =
      status === "done"
        ? await hiddenTests(live, entry)
        : { passed: false, tests: `not run, chain ${status}` };

    return {
      status,
      ...hidden,
      helpers: chain.helpers,
      handover: handoverLines(live, chain, true),
      calls: chain.calls,
      cost: chain.cost,
      durationMs: chain.durationMs,
      failure: chain.failure,
      largestBash,
      record: chainRecord(label, chain),
    };
  } finally {
    await live.close();
  }
};

const rubric: Rubric<Outcome> = [
  {
    name: "hidden tests",
    passes: (outcome) => outcome.status === "done" && outcome.passed,
    explain: (outcome) => `${outcome.status}, ${outcome.tests}`,
  },
];

const describeOutcome = (outcome: Outcome) =>
  [
    `    ${outcome.status}, ${outcome.passed ? "passed" : "failed"} (${outcome.tests})`,
    `, helpers ${outcome.helpers.length}${helperCounts(outcome.helpers)}`,
    `, calls ${outcome.calls}, largest bash ${outcome.largestBash} chars, cost $${outcome.cost.toFixed(2)}, duration ${formatDuration(outcome.durationMs)}`,
    failureSuffix(outcome.failure),
  ].join("");

const caseName = (entry: ImplementerCase) => `subagents/implementer ${entry.sha}`;

const reportedImplementation = async (entry: ImplementerCase, index: number, total: number) => {
  const outcome = await implementOnce(entry, index);

  reportRun(caseName(entry), total, gradeRun(index, outcome, rubric, outcome.record), [
    describeOutcome(outcome),
    ...outcome.handover,
  ]);

  return outcome;
};

describeLive("eval implementer hidden tests", () => {
  it.each(implementerCases)(
    "implements $sha",
    async (entry) => {
      const runs = evalRunCount();
      const outcomes = await repeatRuns(runs, (index) => reportedImplementation(entry, index, runs), {
        parallel: true,
      });
      const result = gradeRuns(caseName(entry), outcomes, rubric, (outcome) => outcome.record);

      reportEval(result);
      expectPassRate(result, MAJORITY);
    },
    RUN_TIMEOUT_MS + TEST_TIMEOUT_MS + 30_000,
  );
});
