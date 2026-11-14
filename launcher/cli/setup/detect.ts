import { join } from "node:path";
import { type Backend, recommendedVmSize } from "../../backend/index.ts";
import { errorMessage } from "../../shared/index.ts";
import { vmBusyCount } from "../vm.ts";
import { folderCandidates, unscannedCandidates } from "./folders.ts";
import type { FolderCandidate, HostFacts, VmFacts } from "./types.ts";

interface DiskStats {
  bavail: number | bigint;
  bsize: number | bigint;
}

export interface DetectDeps {
  home: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  machine: { cpus: number; memoryGiB: number };
  stateDir: string;
  configFile: string;
  docsFile: string;
  configRoots: string[] | undefined;
  firstRun: boolean;
  backend: Backend;
  statfs: (path: string) => Promise<DiskStats>;
  budgetMs?: number;
}

const BUDGET_MS = 3000;

const GIB = 1024 ** 3;

const withinBudget = <T>(pending: Promise<T>, budgetMs: number, fallback: T) => {
  const timer = { handle: undefined as NodeJS.Timeout | undefined };
  const late = new Promise<T>((resolve) => {
    timer.handle = setTimeout(() => resolve(fallback), budgetMs);
  });

  return Promise.race([pending.catch(() => fallback), late]).finally(() => clearTimeout(timer.handle));
};

const freeDiskOf = async (deps: DetectDeps) => {
  const stats = await deps.statfs(join(deps.home, ".colima")).catch(() => deps.statfs(deps.home));

  return Math.floor((Number(stats.bavail) * Number(stats.bsize)) / GIB);
};

const vmFactsOf = (backend: Backend): Promise<VmFacts> =>
  backend.vm
    .inspect()
    .catch((error: unknown) => ({ state: "unknown" as const, reason: errorMessage(error) }));

export const detectHost = async (deps: DetectDeps): Promise<HostFacts> => {
  const budgetMs = deps.budgetMs ?? BUDGET_MS;
  const late: VmFacts = {
    state: "unknown",
    reason: `colima did not answer within ${budgetMs / 1000} seconds`,
  };
  const search = {
    home: deps.home,
    env: deps.env,
    cwd: deps.cwd,
    configRoots: deps.configRoots,
    firstRun: deps.firstRun,
  };
  const [vm, sessions, freeDiskGiB, found] = await Promise.all([
    withinBudget(vmFactsOf(deps.backend), budgetMs, late),
    withinBudget(vmBusyCount(deps.backend, deps.stateDir), budgetMs, 0),
    withinBudget<number | undefined>(freeDiskOf(deps), budgetMs, undefined),
    withinBudget<FolderCandidate[] | "late">(folderCandidates(search), budgetMs, "late"),
  ]);
  const candidates = found === "late" ? unscannedCandidates(search) : found;
  const cpus = deps.machine.cpus;
  const memoryGiB = Math.floor(deps.machine.memoryGiB);
  const facts = {
    home: deps.home,
    cwd: deps.cwd,
    cpus,
    memoryGiB,
    automatic: recommendedVmSize(cpus, memoryGiB),
    vm,
    sessions,
    candidates,
    configFile: deps.configFile,
    docsFile: deps.docsFile,
    ...(found === "late" ? { searchTimedOut: true } : {}),
  };

  return freeDiskGiB === undefined ? facts : { ...facts, freeDiskGiB };
};
