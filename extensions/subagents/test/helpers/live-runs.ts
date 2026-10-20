import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { costOf, waitUntil } from "../../../../core/test/adapter/live.ts";
import { type AgentRecord, chainLinks, chainTerminal, isClosed } from "../../src/model/types.ts";
import { PACKAGE_ROOT } from "./harness.ts";
import type { LiveHarness } from "./live.ts";

export const REPO_ROOT = resolve(PACKAGE_ROOT, "..", "..");

export const RUNS_ENV = "PI_LIVE_PLAN_RUNS";

export const liveRuns = () => Math.max(1, Math.floor(Number(process.env[RUNS_ENV] ?? "1")) || 1);

export const repoGit = (args: string[]) =>
  execFileSync("/usr/bin/git", args, { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

const subtree = (records: AgentRecord[], rootId: string): AgentRecord[] => {
  const children = records.filter((record) => record.callerId === rootId);

  return children.flatMap((child) => [child, ...subtree(records, child.id)]);
};

export type ChainOutcome = {
  terminal: AgentRecord | undefined;
  timedOut: boolean;
  links: AgentRecord[];
  helpers: string[];
  calls: number;
  cost: number;
};

// Runs the lead on the task and waits until its chain (the lead and any
// successors after a handoff) has closed, then sums the chain's own tool calls
// and the cost of the whole tree under it. A chain still open after
// `timeoutMs` is reported as timed out with its figures so far.
export const runChain = async (
  live: LiveHarness,
  agent: string,
  task: string,
  timeoutMs: number,
): Promise<ChainOutcome> => {
  const firstId = await live.run(agent, task);
  const terminal = () => {
    const first = live.registry.get(firstId);

    return first && chainTerminal(live.registry, first);
  };

  const timedOut = await waitUntil(
    () => {
      const last = terminal();

      return last !== undefined && isClosed(last.state) && last.state !== "handoff";
    },
    timeoutMs,
    `${agent} ${firstId} to close`,
  ).then(
    () => false,
    () => true,
  );

  const records = live.registry.list();
  const last = terminal();
  const links = last ? chainLinks(live.registry, last) : [];
  const linkIds = links.map((link) => link.id);
  const tree = [...linkIds, ...linkIds.flatMap((id) => subtree(records, id).map((record) => record.id))];

  return {
    terminal: last,
    timedOut,
    links,
    helpers: records.filter((record) => linkIds.includes(record.callerId)).map((record) => record.agent),
    calls: links.reduce((sum, link) => sum + link.toolCalls, 0),
    cost: costOf(tree.flatMap((id) => live.usage.get(id) ?? [])),
  };
};

export const helperCounts = (helpers: string[]) => {
  const kinds = [...new Set(helpers)].sort();

  return kinds.length > 0
    ? ` (${kinds.map((kind) => `${kind} ${helpers.filter((helper) => helper === kind).length}`).join(", ")})`
    : "";
};

// One harness, and so one seeded project, per run; the runs of a fixture go
// concurrently. A failed run fails the test only after every run has settled,
// so no run outlives the test.
export const concurrentRuns = async <T>(runs: number, once: (index: number) => Promise<T>) => {
  const settled = await Promise.allSettled(Array.from({ length: runs }, (_, index) => once(index)));
  const failed = settled.find((result) => result.status === "rejected");

  if (failed) {
    throw failed.reason;
  }

  return settled.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
};
