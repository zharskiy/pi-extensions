import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { describeLive } from "../../../../core/test/adapter/live.ts";
import type { AgentRecord } from "../../src/model/types.ts";
import { largestOutput } from "../helpers/findings.ts";
import { createLiveHarness, type LiveHarness } from "../helpers/live.ts";
import {
  concurrentRuns,
  failureSuffix,
  handoverLines,
  helperCounts,
  liveRuns,
  repoGit,
  runChain,
} from "../helpers/live-runs.ts";

// One past commit of this repository that changes a few source files and adds
// tests. The implementer gets the tree at the commit's parent and the request
// as a user would phrase it; afterwards the commit's own test files (hidden
// from the implementer) are copied in and run. The run passes when they pass.
type Fixture = { sha: string; task: string; tests: string[] };

type Outcome = {
  status: string;
  passed: boolean;
  tests: string;
  helpers: string[];
  handover: string[];
  calls: number;
  cost: number;
  failure: string | undefined;
  largestBash: number;
};

const RUN_TIMEOUT_MS = 420_000;

const TEST_TIMEOUT_MS = 120_000;

const fixtures: Fixture[] = [
  {
    // One function in one file: the shared editor record on globalThis may
    // come from an older package copy without `history`. The hidden test plants
    // such a record and checks ↑ recall. Verified: it fails at 1622d24^ (1 of 40)
    // and passes at 1622d24.
    sha: "1622d24",
    task: 'In core/adapter/pi-editor.ts our editor keeps its shared state on globalThis under Symbol.for("pi-extensions.editor-hooks"), so every copy of the package uses one record. A record left there by an older copy of the package has only `emptyLeft` and `emptyDown`, no `history`, and then ↑ prompt recall in our editor breaks. Make the editor fill in whatever fields are missing on an existing record instead of assuming it is complete.',
    tests: ["core/test/adapter/pi-editor.test.ts"],
  },
  {
    // State-machine change in one file: one tracked wait becomes a map of waits
    // by owner. The hidden tests cover a dialog over a waiting form, a form
    // over a dialog, and idle held until every wait closes. Verified: 3 of 33
    // fail at 5af06ac^ and all pass at 5af06ac.
    sha: "5af06ac",
    task: "In the notifications extension (extensions/notifications/src/notifications.ts) only one awaiting-input wait is tracked at a time. When the questionnaire form is waiting and a pi dialog opens and closes over it, or the other way round, the wait that is still open never gets its `pi needs your input` notification, and the idle notification is not held for it either. Track every open wait by its owner: when one closes while another that has not notified yet is still open, restart the dialog delay for it; a notification uses the title of the most recently opened wait that is still open and counts as sent for every open wait; the idle notification waits until every wait has closed.",
    tests: ["extensions/notifications/test/notifications.test.ts"],
  },
  {
    // Harder: the task names only what the user sees, so the places to change
    // take a search across three directories of the subagents extension: the
    // footer status in plugins/agent-panel/index.ts, its counter text in
    // components/format.ts and the hint duration setting in model/settings.ts
    // (old settings files that still carry the key must load cleanly).
    // Verified: 2 of 48 fail at eb0177e^ and all pass at eb0177e.
    sha: "eb0177e",
    task: "The subagents footer status shows `N agents` while agents run and `/agents to see agents` for a while after the last one finishes. The agent panel already lists every open agent and the run_agent block says how to open the list, so both are just noise. Remove that footer status entirely, along with the setting that controls how long the hint stays and any helper that becomes unused. A settings file that still has the old key must keep loading without a warning.",
    tests: [
      "extensions/subagents/test/components/format.test.ts",
      "extensions/subagents/test/model/settings.test.ts",
      "extensions/subagents/test/plugins/agent-panel/agent-panel.test.ts",
    ],
  },
];

const runs = liveRuns();

const SUMMARY = /Tests\s+(.*?\(\d+\))/;

const execFileAsync = promisify(execFile);

type ExecFailure = { stdout?: string; stderr?: string; code?: number | string; signal?: string };

// Async so one run's hidden tests do not block the event loop of the other
// runs going concurrently.
const hiddenTests = async (live: LiveHarness, fixture: Fixture) => {
  fixture.tests.forEach((file) => {
    writeFileSync(join(live.project, file), repoGit(["show", `${fixture.sha}:${file}`]));
  });

  const options = {
    cwd: live.project,
    encoding: "utf8" as const,
    timeout: TEST_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
  };

  return execFileAsync("npx", ["vitest", "run", ...fixture.tests], options).then(
    ({ stdout, stderr }) => ({ passed: true, tests: SUMMARY.exec(`${stdout}${stderr}`)?.[1] ?? "exit 0" }),
    (error: ExecFailure) => ({
      passed: false,
      tests:
        SUMMARY.exec(`${error.stdout ?? ""}${error.stderr ?? ""}`)?.[1] ??
        `exit ${error.code ?? error.signal}`,
    }),
  );
};

const largestBashOf = (live: LiveHarness, links: AgentRecord[]) =>
  links.reduce((max, link) => {
    const items = link.sessionFile ? live.runtime.readSession(link.sessionFile).items : [];
    const outputs = items.flatMap((item) => (item.kind === "tool" ? [item] : []));

    return Math.max(max, largestOutput(outputs, "bash"));
  }, 0);

const implementOnce = async (fixture: Fixture, index: number): Promise<Outcome> => {
  const live = createLiveHarness(`implement ${fixture.sha} run ${index + 1}`, {
    agents: {
      implementer: { from: "implementer", fields: { limit: "120000" } },
      scout: { from: "scout" },
      shell: { from: "shell" },
    },
  });

  try {
    live.seed(`${fixture.sha}^`);

    const chain = await runChain(live, "implementer", fixture.task, RUN_TIMEOUT_MS);
    const largestBash = largestBashOf(live, chain.links);
    const status = chain.timedOut ? "timeout" : (chain.terminal?.state ?? "missing");
    const hidden =
      status === "done"
        ? await hiddenTests(live, fixture)
        : { passed: false, tests: `not run, chain ${status}` };

    return {
      status,
      ...hidden,
      helpers: chain.helpers,
      handover: handoverLines(live, chain, true),
      calls: chain.calls,
      cost: chain.cost,
      failure: chain.failure,
      largestBash,
    };
  } finally {
    await live.close();
  }
};

const describeOutcome = (outcome: Outcome) =>
  [
    `${outcome.status}, ${outcome.passed ? "passed" : "failed"} (${outcome.tests})`,
    `, helpers ${outcome.helpers.length}${helperCounts(outcome.helpers)}`,
    `, calls ${outcome.calls}, largest bash ${outcome.largestBash} chars, cost $${outcome.cost.toFixed(2)}`,
    failureSuffix(outcome.failure),
  ].join("");

describeLive("live implementer change quality", () => {
  it.each(fixtures)(
    "implements $sha",
    async (fixture) => {
      const outcomes = await concurrentRuns(runs, async (index) => {
        const outcome = await implementOnce(fixture, index);

        console.log(
          [
            `[live implement] ${fixture.sha} run ${index + 1}/${runs}: ${describeOutcome(outcome)}`,
            ...outcome.handover,
          ].join("\n"),
        );

        return outcome;
      });

      const passed = outcomes.filter((outcome) => outcome.status === "done" && outcome.passed).length;
      const total = outcomes.reduce((sum, outcome) => sum + outcome.cost, 0);

      console.log(
        `[live implement] ${fixture.sha}: passed ${passed}/${runs}, mean cost $${(total / runs).toFixed(2)}`,
      );

      expect(passed).toBeGreaterThan(runs / 2);
    },
    RUN_TIMEOUT_MS + TEST_TIMEOUT_MS + 30_000,
  );
});
