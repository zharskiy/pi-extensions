import { lstat } from "node:fs/promises";
import { type CliDeps, pathsOf } from "../deps.ts";
import { proposedConfigFile, readReceipt, type StoredReceipt } from "../install-receipt.ts";
import { launcherVersion } from "../versions.ts";
import { type CheckResult, passed, skipped, warned } from "./doctor-checks.ts";
import { hostPackageSources } from "./extensions.ts";

interface InstallProblem {
  problem: string;
  hint: string;
}

const NO_RECEIPT = "installed without a receipt";

const RUN_AGAIN = "run your organisation's install command again";

const NPM_PIN = /^npm:.+@(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?)$/;

const GIT_TAG = /@v(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?)$/;

const pinnedVersion = (source: string) =>
  (source.startsWith("npm:") ? NPM_PIN.exec(source) : GIT_TAG.exec(source))?.[1];

const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

const versionProblems = (receipt: StoredReceipt, launcher: string): InstallProblem[] =>
  receipt.version === undefined || receipt.version === launcher
    ? []
    : [
        {
          problem: `the receipt records ${receipt.version}, but the launcher is ${launcher}`,
          hint: RUN_AGAIN,
        },
      ];

const extensionsProblems = async (deps: CliDeps, receipt: StoredReceipt, launcher: string) => {
  const source = receipt.extensions?.source;

  if (source === undefined) {
    return [];
  }

  if (!(await hostPackageSources(deps)).includes(source)) {
    return [
      {
        problem: `the extensions source ${source} is no longer in host pi's packages`,
        hint: `${RUN_AGAIN}, or pi install ${source}`,
      },
    ];
  }

  const pinned = pinnedVersion(source);

  return pinned === undefined || pinned === launcher
    ? []
    : [{ problem: `the extensions are ${pinned} (${source}), the launcher is ${launcher}`, hint: RUN_AGAIN }];
};

const proposedProblems = async (deps: CliDeps): Promise<InstallProblem[]> => {
  const { userConfigFile } = pathsOf(deps);
  const proposed = proposedConfigFile(userConfigFile);

  return (await exists(proposed))
    ? [
        {
          problem: `${proposed} holds an organisation config that was not applied because ${userConfigFile} was edited`,
          hint: `compare the two, then move ${proposed} over ${userConfigFile} to adopt it, or delete it to keep yours`,
        },
      ]
    : [];
};

const installState = async (deps: CliDeps) => {
  const receipt = await readReceipt(pathsOf(deps).stateDir);
  const proposed = await proposedProblems(deps);

  if (receipt === undefined) {
    return { receipt, problems: proposed };
  }

  const launcher = await launcherVersion();
  const extensions = await extensionsProblems(deps, receipt, launcher);

  return { receipt, problems: [...versionProblems(receipt, launcher), ...extensions, ...proposed] };
};

const summaryOf = (receipt: StoredReceipt) =>
  [
    `${receipt.version ?? "unknown version"} (${receipt.mode ?? "unknown mode"})`,
    `extensions ${receipt.extensions?.source ?? "not installed by the installer"}`,
    `config ${receipt.config?.outcome ?? "not seeded"}`,
  ].join(", ");

export const checkInstall = async (deps: CliDeps): Promise<CheckResult> => {
  const { receipt, problems } = await installState(deps);
  const [first, ...rest] = problems;

  if (first === undefined) {
    return receipt === undefined ? skipped(NO_RECEIPT) : passed(summaryOf(receipt));
  }

  return warned(first.problem, {
    reasons: rest.map((problem) => problem.problem),
    hint: [...new Set(problems.map((problem) => problem.hint))].join("; "),
  });
};

export const installStatusLine = async (deps: CliDeps) => {
  const { receipt, problems } = await installState(deps);
  const warnings = problems.length === 0 ? "" : `; ${problems.length} warnings, see pi sandbox doctor`;

  if (receipt === undefined) {
    return `install: ${NO_RECEIPT}${warnings}`;
  }

  return `install: ${summaryOf(receipt)}, at ${receipt.installedAt ?? "an unknown time"}, smoke ${receipt.smoke ?? "unknown"}${warnings}`;
};
