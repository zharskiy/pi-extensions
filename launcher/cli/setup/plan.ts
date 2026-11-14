import { hasSizeChanges, shareDrift, type VmShare, type VmSpec, vmSizeDrift } from "../../backend/index.ts";
import { VM_BOUNDS, validateConfig } from "../../config/index.ts";
import { errorMessage, type JsonObject, LauncherError } from "../../shared/index.ts";
import { checkRoot, type RootGuardContext, rootRefusal } from "../../workspace/index.ts";
import { hostVmLimits } from "../vm.ts";
import { diffOf, isReindented, serialise, valueAt, withoutValue, withValue } from "./document.ts";
import { isPreChecked, rootsFromEnv, sameRootSet } from "./folders.ts";
import type {
  Answers,
  ConfigDocument,
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

interface YesAnswers {
  answers: Answers;
  notices: string[];
}

const VM_KEYS: readonly VmKey[] = ["cpus", "memoryGiB", "diskGiB"];

export const FIRST_RUN_STEPS: readonly Section[] = ["folders", "vm", "writeBack"];

const ROOTS_PATH = ["workspaceRoots", "roots"];

const WRITE_BACK_PATH = ["writeBack", "enabled"];

const problemIn = (layer: unknown) => {
  try {
    validateConfig(layer);

    return undefined;
  } catch (error) {
    return errorMessage(error);
  }
};

export const isFirstRun = (document: ConfigDocument) =>
  valueAt(document.value, ["workspaceRoots"]) === undefined;

export const firstRunSteps = (document: ConfigDocument): readonly Section[] =>
  isFirstRun(document) ? FIRST_RUN_STEPS : [];

export const configuredRoots = (document: ConfigDocument) => {
  const roots = valueAt(document.value, ROOTS_PATH);

  return Array.isArray(roots) && roots.every((root) => typeof root === "string") ? roots : undefined;
};

const rootProblems = (document: ConfigDocument, context: RootGuardContext): OwnedProblem[] => {
  const workspaceRoots = valueAt(document.value, ["workspaceRoots"]);

  if (workspaceRoots === undefined) {
    return [];
  }

  const shape = problemIn({ workspaceRoots });

  if (shape !== undefined) {
    return [{ key: "workspaceRoots", message: shape }];
  }

  return (configuredRoots(document) ?? []).flatMap((root) => {
    const verdict = checkRoot(root, context);

    return verdict.ok ? [] : [{ key: "workspaceRoots.roots", message: rootRefusal(root, verdict.problem) }];
  });
};

const vmProblems = (document: ConfigDocument): OwnedProblem[] =>
  VM_KEYS.flatMap((key) => {
    const value = valueAt(document.value, ["vm", key]);
    const resources = document.value.resources === undefined ? {} : { resources: document.value.resources };
    const problem = value === undefined ? undefined : problemIn({ vm: { [key]: value }, ...resources });

    return problem === undefined ? [] : [{ key: `vm.${key}`, message: problem }];
  });

const writeBackProblems = (document: ConfigDocument): OwnedProblem[] => {
  const enabled = valueAt(document.value, WRITE_BACK_PATH);
  const problem = enabled === undefined ? undefined : problemIn({ writeBack: { enabled } });

  return problem === undefined ? [] : [{ key: "writeBack.enabled", message: problem }];
};

export const ownedProblems = (document: ConfigDocument, context: RootGuardContext): OwnedProblem[] => [
  ...rootProblems(document, context),
  ...vmProblems(document),
  ...writeBackProblems(document),
];

const isInvalid = (problems: OwnedProblem[], key: string) => problems.some((problem) => problem.key === key);

const validRoots = (document: ConfigDocument, context: RootGuardContext) =>
  (configuredRoots(document) ?? []).filter((root) => checkRoot(root, context).ok);

const detectedRoots = (document: ConfigDocument, facts: HostFacts) =>
  facts.candidates
    .filter((candidate) => isPreChecked(candidate, isFirstRun(document)))
    .map((candidate) => candidate.stored);

const initialRoots = (document: ConfigDocument, facts: HostFacts, context: RootGuardContext) => {
  if (isFirstRun(document) || isInvalid(ownedProblems(document, context), "workspaceRoots")) {
    return detectedRoots(document, facts);
  }

  return validRoots(document, context);
};

const fileVm = (document: ConfigDocument) =>
  Object.fromEntries(
    VM_KEYS.flatMap((key) => {
      const value = valueAt(document.value, ["vm", key]);

      return typeof value === "number" ? [[key, value]] : [];
    }),
  ) as Partial<VmSpec>;

const initialVm = (document: ConfigDocument, facts: HostFacts, problems: OwnedProblem[]): Answers["vm"] => {
  const configured = fileVm(document);
  const valid = Object.fromEntries(
    Object.entries(configured).filter(([key]) => !isInvalid(problems, `vm.${key}`)),
  ) as Partial<VmSpec>;
  const anyInvalid = VM_KEYS.some((key) => isInvalid(problems, `vm.${key}`));

  if (anyInvalid) {
    return { ...facts.automatic, ...valid };
  }

  return Object.keys(configured).length === 0 ? "automatic" : { kept: configured };
};

const initialWriteBack = (document: ConfigDocument) => {
  const enabled = valueAt(document.value, WRITE_BACK_PATH);

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
    roots: initialRoots(document, facts, context),
    vm: initialVm(document, facts, problems),
    writeBack: initialWriteBack(document),
  };
};

const editedRoots = (value: JsonObject, roots: Answers["roots"]) =>
  roots === "home" ? withoutValue(value, ["workspaceRoots"]) : withValue(value, ROOTS_PATH, roots);

const editedVm = (value: JsonObject, vm: Answers["vm"]) => {
  if (vm === "automatic") {
    return VM_KEYS.reduce((edited, key) => withoutValue(edited, ["vm", key]), value);
  }

  if ("kept" in vm) {
    return value;
  }

  return VM_KEYS.reduce((edited, key) => withValue(edited, ["vm", key], vm[key]), value);
};

const editedWriteBack = (value: JsonObject, enabled: boolean) => {
  const current = valueAt(value, WRITE_BACK_PATH);

  if (current === undefined && enabled) {
    return value;
  }

  return withValue(value, WRITE_BACK_PATH, enabled);
};

export const editedConfig = (value: JsonObject, answers: Answers) =>
  editedWriteBack(editedVm(editedRoots(value, answers.roots), answers.vm), answers.writeBack);

const wantedSize = (vm: Answers["vm"]) => {
  if (vm === "automatic") {
    return undefined;
  }

  return "kept" in vm ? vm.kept : vm;
};

const sharesDiffer = (current: VmShare[] | "unreadable", shares: VmShare[], exact: boolean) => {
  if (current === "unreadable") {
    return true;
  }

  const drift = shareDrift(current, shares);

  return drift.lacking.length > 0 || (exact && drift.extra.length > 0);
};

export const vmActionOf = (
  answers: Answers,
  facts: HostFacts,
  share: { shares: VmShare[]; exact: boolean },
): VmAction => {
  const wanted = wantedSize(answers.vm);

  if (facts.vm.state === "absent") {
    return { kind: "create", size: { ...facts.automatic, ...wanted }, shares: share.shares };
  }

  if (facts.vm.state === "unknown") {
    return { kind: "unknown", reason: facts.vm.reason };
  }

  const current = facts.vm;
  const sized = wanted !== undefined && hasSizeChanges(vmSizeDrift(current.size, wanted));
  const parts: VmPart[] = [
    ...(sized ? ["size" as const] : []),
    ...(sharesDiffer(current.shares, share.shares, share.exact) ? ["folders" as const] : []),
  ];

  if (parts.length === 0) {
    return { kind: "none" };
  }

  if (current.state === "stopped") {
    return { kind: "on-next-start", parts };
  }

  if (facts.sessions > 0) {
    return { kind: "defer", sessions: facts.sessions, parts };
  }

  return {
    kind: "restart",
    size: { ...current.size, ...wanted },
    shares: share.shares,
    exactShares: share.exact,
    parts,
  };
};

const rootsProblem = (roots: Answers["roots"]) =>
  Array.isArray(roots) && roots.length === 0
    ? ["choose at least one project folder, or share your home"]
    : [];

export const planOf = (
  document: ConfigDocument,
  answers: Answers,
  facts: HostFacts,
  share: SharePlan,
): Plan => {
  const next = editedConfig(document.value, answers);
  const changes = diffOf(document.value, next);
  const invalid = problemIn(next);
  const problems = [
    ...("problem" in share ? [share.problem] : []),
    ...rootsProblem(answers.roots),
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

const yesRoots = (document: ConfigDocument, facts: HostFacts, env: NodeJS.ProcessEnv) => {
  const context = { home: facts.home, env };
  const configured = configuredRoots(document);
  const fromEnv = rootsFromEnv(env, facts.cwd);
  const shape = rootProblems(document, context).find((problem) => problem.key === "workspaceRoots");

  if (shape !== undefined) {
    throw new LauncherError(shape.message, `fix ${document.file}`);
  }

  if (configured !== undefined && fromEnv.length > 0 && !sameRootSet(configured, fromEnv, context)) {
    throw new LauncherError(
      `${document.file} has other workspaceRoots than PI_SANDBOX_ROOTS`,
      `edit workspaceRoots in ${document.file}, or unset PI_SANDBOX_ROOTS`,
    );
  }

  if (configured !== undefined) {
    return { roots: configured, notices: [] };
  }

  if (fromEnv.length === 0) {
    return {
      roots: "home" as const,
      notices: [
        "no workspaceRoots, so the sandbox VM shares your whole home; run pi sandbox init in a terminal to choose project folders",
      ],
    };
  }

  const refused = fromEnv.flatMap((root) => {
    const verdict = checkRoot(root, context);

    return verdict.ok ? [] : [rootRefusal(root, verdict.problem)];
  });

  if (refused.length > 0) {
    throw new LauncherError(refused[0] ?? "", "name the project folders themselves in PI_SANDBOX_ROOTS");
  }

  return { roots: fromEnv, notices: [] };
};

export const answersForYes = (
  document: ConfigDocument,
  facts: HostFacts,
  env: NodeJS.ProcessEnv,
): YesAnswers => {
  const configured = fileVm(document);
  const roots = yesRoots(document, facts, env);
  const answers: Answers = {
    roots: roots.roots,
    vm: Object.keys(configured).length === 0 ? "automatic" : { kept: configured },
    writeBack: initialWriteBack(document),
  };

  return { answers, notices: roots.notices };
};

const vmDiskOf = (facts: HostFacts) =>
  facts.vm.state === "running" || facts.vm.state === "stopped" ? facts.vm.size.diskGiB : 0;

export const vmBounds = (facts: HostFacts): VmBounds => {
  const limits = hostVmLimits(facts);

  return {
    cpus: { min: VM_BOUNDS.cpus.min, max: limits.cpus },
    memoryGiB: { min: VM_BOUNDS.memoryGiB.min, max: limits.memoryGiB },
    diskGiB: {
      min: Math.min(VM_BOUNDS.diskGiB.max, Math.max(VM_BOUNDS.diskGiB.min, vmDiskOf(facts))),
      max: VM_BOUNDS.diskGiB.max,
    },
  };
};

export const isPlanEmpty = (plan: Plan) => plan.changes.length === 0 && plan.vm.kind === "none";
