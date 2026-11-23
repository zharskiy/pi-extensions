import { type VmShare, type VmSpec, vmDecision, whenBusy } from "../../backend/index.ts";
import { configProblem, getPath, setPath, VM_BOUNDS, withoutPath } from "../../config/index.ts";
import { type JsonObject, LauncherError } from "../../shared/index.ts";
import { checkRoot, type RootGuardContext, rootRefusal } from "../../workspace/index.ts";
import { clamp, hostVmLimits } from "../vm.ts";
import { diffOf, isReindented, SECTIONS, serialise, VM_KEYS, WRITE_BACK_PATH } from "./document.ts";
import { refusedRootMessage, rootFromEnv, sameRoot } from "./folders.ts";
import type {
  Answers,
  ConfigDocument,
  FolderCandidate,
  HostFacts,
  OwnedProblem,
  Plan,
  Section,
  SharePlan,
  VmAction,
  VmPart,
} from "./types.ts";

type VmKey = keyof VmSpec;

interface Bound {
  min: number;
  max: number;
}

export type VmBounds = Record<VmKey, Bound>;

const ROOT_PATH = "workspaceRoot";

export const NO_ROOT = "choose the folder that holds your projects";

export const isFirstRun = (document: ConfigDocument) => getPath(document.value, ROOT_PATH) === undefined;

export const firstRunSteps = (document: ConfigDocument): readonly Section[] =>
  isFirstRun(document) ? SECTIONS : [];

export const configuredRoot = (document: ConfigDocument) => {
  const root = getPath(document.value, ROOT_PATH);

  return typeof root === "string" ? root : undefined;
};

const shapeProblem = (document: ConfigDocument) => {
  const workspaceRoot = getPath(document.value, ROOT_PATH);

  return workspaceRoot === undefined ? undefined : configProblem({ workspaceRoot });
};

const rootProblems = (document: ConfigDocument, context: RootGuardContext): OwnedProblem[] => {
  const root = configuredRoot(document);
  const message =
    shapeProblem(document) ?? (root === undefined ? undefined : refusedRootMessage(root, context));

  return message === undefined ? [] : [{ key: ROOT_PATH, message }];
};

const vmProblems = (document: ConfigDocument): OwnedProblem[] =>
  VM_KEYS.flatMap((key) => {
    const value = getPath(document.value, `vm.${key}`);
    const resources = document.value.resources === undefined ? {} : { resources: document.value.resources };
    const problem = value === undefined ? undefined : configProblem({ vm: { [key]: value }, ...resources });

    return problem === undefined ? [] : [{ key: `vm.${key}`, message: problem }];
  });

const writeBackProblems = (document: ConfigDocument): OwnedProblem[] => {
  const enabled = getPath(document.value, WRITE_BACK_PATH);
  const problem = enabled === undefined ? undefined : configProblem({ writeBack: { enabled } });

  return problem === undefined ? [] : [{ key: WRITE_BACK_PATH, message: problem }];
};

export const ownedProblems = (document: ConfigDocument, context: RootGuardContext): OwnedProblem[] => [
  ...rootProblems(document, context),
  ...vmProblems(document),
  ...writeBackProblems(document),
];

const isInvalid = (problems: OwnedProblem[], key: string) => problems.some((problem) => problem.key === key);

const ORIGIN_RANK: Record<FolderCandidate["origin"], number> = { config: 0, env: 1, cwd: 2, usual: 3 };

const detectedRoot = (facts: HostFacts) =>
  facts.candidates
    .filter(
      (candidate) => candidate.origin !== "config" && (candidate.origin !== "usual" || candidate.repos > 0),
    )
    .sort((left, right) => ORIGIN_RANK[left.origin] - ORIGIN_RANK[right.origin])[0]?.stored;

const initialRoot = (document: ConfigDocument, facts: HostFacts, context: RootGuardContext) => {
  if (isFirstRun(document) || isInvalid(ownedProblems(document, context), ROOT_PATH)) {
    return detectedRoot(facts);
  }

  return configuredRoot(document);
};

const fileVm = (document: ConfigDocument) =>
  Object.fromEntries(
    VM_KEYS.flatMap((key) => {
      const value = getPath(document.value, `vm.${key}`);

      return typeof value === "number" ? [[key, value]] : [];
    }),
  ) as Partial<VmSpec>;

const initialVm = (document: ConfigDocument, problems: OwnedProblem[]): Answers["vm"] => {
  const configured = fileVm(document);
  const valid = Object.fromEntries(
    Object.entries(configured).filter(([key]) => !isInvalid(problems, `vm.${key}`)),
  ) as Partial<VmSpec>;

  return Object.keys(valid).length === 0 ? "automatic" : { kept: valid };
};

const initialWriteBack = (document: ConfigDocument) => {
  const enabled = getPath(document.value, WRITE_BACK_PATH);

  return typeof enabled === "boolean" ? enabled : true;
};

export const initialAnswers = (
  document: ConfigDocument,
  facts: HostFacts,
  env: NodeJS.ProcessEnv,
): Answers => {
  const context = { home: facts.home, env };
  const problems = ownedProblems(document, context);

  return {
    root: initialRoot(document, facts, context),
    vm: initialVm(document, problems),
    writeBack: initialWriteBack(document),
  };
};

const editedRoot = (value: JsonObject, root: Answers["root"]) =>
  root === undefined ? value : setPath(value, ROOT_PATH, root);

const editedVm = (value: JsonObject, vm: Answers["vm"]) => {
  if (vm === "automatic") {
    return VM_KEYS.reduce((edited, key) => withoutPath(edited, `vm.${key}`), value);
  }

  if ("kept" in vm) {
    return VM_KEYS.reduce(
      (edited, key) => (key in vm.kept ? edited : withoutPath(edited, `vm.${key}`)),
      value,
    );
  }

  return VM_KEYS.reduce((edited, key) => setPath(edited, `vm.${key}`, vm[key]), value);
};

const editedWriteBack = (value: JsonObject, enabled: boolean) => {
  const current = getPath(value, WRITE_BACK_PATH);

  if (current === undefined && enabled) {
    return value;
  }

  return setPath(value, WRITE_BACK_PATH, enabled);
};

export const editedConfig = (value: JsonObject, answers: Answers) =>
  editedWriteBack(editedVm(editedRoot(value, answers.root), answers.vm), answers.writeBack);

const wantedSize = (vm: Answers["vm"]) => {
  if (vm === "automatic") {
    return undefined;
  }

  return "kept" in vm ? vm.kept : vm;
};

const partsOf = (change: { resize: object; reshare: boolean }): VmPart[] => [
  ...(Object.keys(change.resize).length > 0 ? ["size" as const] : []),
  ...(change.reshare ? ["folders" as const] : []),
];

export const vmActionOf = (answers: Answers, facts: HostFacts, share: { shares: VmShare[] }): VmAction => {
  const wanted = wantedSize(answers.vm);

  if (facts.vm.state === "unknown") {
    return { kind: "unknown", reason: facts.vm.reason };
  }

  const current = facts.vm;

  if (current.state === "absent") {
    return { kind: "create", size: { ...facts.automatic, ...wanted }, shares: share.shares };
  }

  const decision = whenBusy(
    vmDecision(current, { size: wanted ?? {}, shares: share.shares }),
    facts.sessions,
  );

  if (decision.kind === "stopped") {
    return { kind: "on-next-start", parts: partsOf(decision) };
  }

  if (decision.kind === "defer") {
    return { kind: "defer", sessions: decision.sessions, parts: partsOf(decision) };
  }

  if (decision.kind !== "restart") {
    return { kind: "none" };
  }

  return {
    kind: "restart",
    size: { ...current.size, ...wanted },
    shares: share.shares,
    parts: partsOf(decision),
  };
};

export const planOf = (
  document: ConfigDocument,
  answers: Answers,
  facts: HostFacts,
  share: SharePlan,
): Plan => {
  const next = editedConfig(document.value, answers);
  const changes = diffOf(document.value, next);
  const invalid = configProblem(next);
  const problems = [
    ...("problem" in share ? [share.problem] : []),
    ...(invalid === undefined ? [] : [invalid]),
  ];

  return {
    next,
    text: serialise(document, next),
    changes,
    reindented: changes.length > 0 && isReindented(document),
    vm: "problem" in share ? { kind: "none" } : vmActionOf(answers, facts, share),
    problems,
  };
};

const yesRoot = (document: ConfigDocument, facts: HostFacts, env: NodeJS.ProcessEnv) => {
  const context = { home: facts.home, env };
  const configured = configuredRoot(document);
  const fromEnv = rootFromEnv(env, facts.cwd);
  const shape = shapeProblem(document);

  if (shape !== undefined) {
    throw new LauncherError(shape, `fix ${document.file}`);
  }

  if (configured !== undefined && fromEnv !== undefined && !sameRoot(configured, fromEnv, context)) {
    throw new LauncherError(
      `${document.file} has another workspaceRoot than PI_SANDBOX_ROOT`,
      `edit workspaceRoot in ${document.file}, or unset PI_SANDBOX_ROOT`,
    );
  }

  if (configured !== undefined) {
    return configured;
  }

  if (fromEnv === undefined) {
    throw new LauncherError(
      `${document.file} has no workspaceRoot and PI_SANDBOX_ROOT is not set, so there is no folder to share with the sandbox VM`,
      "run pi sandbox init in a terminal to choose the folder that holds your projects, or set PI_SANDBOX_ROOT to it",
    );
  }

  const verdict = checkRoot(fromEnv, context);

  if (!verdict.ok) {
    throw new LauncherError(
      rootRefusal(fromEnv, verdict.problem),
      "point PI_SANDBOX_ROOT at the folder that holds your projects",
    );
  }

  return fromEnv;
};

export const answersForYes = (
  document: ConfigDocument,
  facts: HostFacts,
  env: NodeJS.ProcessEnv,
): Answers => {
  const configured = fileVm(document);

  return {
    root: yesRoot(document, facts, env),
    vm: Object.keys(configured).length === 0 ? "automatic" : { kept: configured },
    writeBack: initialWriteBack(document),
  };
};

export const existingVm = (facts: HostFacts) =>
  facts.vm.state === "running" || facts.vm.state === "stopped" ? facts.vm : undefined;

export const vmBounds = (facts: HostFacts): VmBounds => {
  const limits = hostVmLimits(facts);

  return {
    cpus: { min: VM_BOUNDS.cpus.min, max: limits.cpus },
    memoryGiB: { min: VM_BOUNDS.memoryGiB.min, max: limits.memoryGiB },
    diskGiB: {
      min: clamp(existingVm(facts)?.size.diskGiB ?? 0, VM_BOUNDS.diskGiB),
      max: VM_BOUNDS.diskGiB.max,
    },
  };
};

export const isPlanEmpty = (plan: Plan) => plan.changes.length === 0 && plan.vm.kind === "none";
