import { readFile, realpath, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { validateConfig } from "../../config/index.ts";
import {
  errorMessage,
  type JsonObject,
  LauncherError,
  parseJsonObject,
  readJsonFile,
  sha256Hex,
  writeFileAtomic,
  writeNewFile,
} from "../../shared/index.ts";
import { sharedRootsOf } from "../../workspace/index.ts";
import { type CliDeps, pathsOf, writeLine, writeLines } from "../deps.ts";
import { backupConfigFile, type ConfigOutcome, proposedConfigFile, readReceipt } from "../install-receipt.ts";
import { plannedRootsOutcome, storedRoot } from "./init-config.ts";

export const SEED_CONFIG = "__seed-config";

const CONFIG_REJECTED_EXIT = 78;

const CONFIG_MODE = 0o600;

const CONFLICTS = ["keep", "replace", "fail"] as const;

type Conflict = (typeof CONFLICTS)[number];

interface SeedArgs {
  check: boolean;
  from?: string;
  conflict: Conflict;
  roots: string[];
}

interface Plan {
  outcome: ConfigOutcome | "none";
  sha256?: string;
  text?: string;
  current?: string;
  roots?: string[];
}

const isConflict = (value: string | undefined): value is Conflict =>
  CONFLICTS.some((conflict) => conflict === value);

const flagValue = (options: string[], flag: string) => {
  const index = options.indexOf(flag);

  return index < 0 ? undefined : options[index + 1];
};

const parseSeedArgs = (args: string[]): SeedArgs => {
  const split = args.indexOf("--");
  const options = split < 0 ? args : args.slice(0, split);
  const conflict = flagValue(options, "--conflict") ?? "keep";

  if (!isConflict(conflict)) {
    throw new LauncherError(`${SEED_CONFIG}: --conflict must be keep, replace or fail`);
  }

  return {
    check: options.includes("--check"),
    from: flagValue(options, "--from"),
    conflict,
    roots: split < 0 ? [] : args.slice(split + 1),
  };
};

const rejection = (message: string) => ({ rejected: message });

const readCurrent = (file: string) =>
  readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return undefined;
    }

    throw new LauncherError(`${file}: ${errorMessage(error)}`);
  });

const assertValidFile = async (file: string) => {
  const value = await readJsonFile<unknown>(file).catch(() => {
    throw new LauncherError(`${file} is not valid JSON`, `fix ${file}`);
  });

  if (value !== undefined) {
    validateConfig(value);
  }
};

const candidateOf = (deps: CliDeps, value: JsonObject, roots: string[]) => {
  const candidate = roots.length === 0 ? value : { ...value, workspaceRoots: { roots } };
  const config = validateConfig(candidate);

  const shared =
    config.workspaceRoots === undefined
      ? undefined
      : sharedRootsOf(config.workspaceRoots, { home: deps.home, env: deps.env });

  return {
    text: `${JSON.stringify(candidate, null, 2)}\n`,
    roots: shared === undefined ? undefined : [...shared.roots, ...shared.missing],
  };
};

const sameConfig = (current: string, text: string) =>
  current === text || isDeepStrictEqual(parseJsonObject(current), JSON.parse(text));

const validated = (deps: CliDeps, value: JsonObject, roots: string[]) => {
  try {
    return candidateOf(deps, value, roots);
  } catch (error) {
    return rejection(errorMessage(error));
  }
};

const conflictPlan = (
  parsed: SeedArgs,
  file: string,
  written: { text: string; current: string; roots?: string[] },
  recorded?: string,
) => {
  if (parsed.conflict === "fail") {
    return rejection(
      `${file} was edited since the installer last wrote it (or was not written by it); --config-conflict fail leaves it as it is`,
    );
  }

  return parsed.conflict === "keep"
    ? { outcome: "kept" as const, sha256: recorded, text: written.text, current: written.current }
    : { outcome: "replaced" as const, sha256: sha256Hex(written.text), ...written };
};

const seedPlan = async (deps: CliDeps, parsed: SeedArgs, from: string, roots: string[]) => {
  const source = resolve(deps.cwd, from);
  const raw = await readFile(source, "utf8").catch(() => undefined);
  const value = raw === undefined ? undefined : parseJsonObject(raw);

  if (raw === undefined) {
    return rejection(`cannot read the --config file ${source}`);
  }

  if (value === undefined) {
    return rejection(`the --config file ${source} is not a JSON object`);
  }

  const candidate = validated(deps, value, roots);

  if ("rejected" in candidate) {
    return candidate;
  }

  const { text, roots: sharedRoots } = candidate;
  const file = pathsOf(deps).userConfigFile;
  const current = await readCurrent(file);
  const recorded = (await readReceipt(pathsOf(deps).stateDir))?.config?.sha256 ?? undefined;

  if (current === undefined) {
    return { outcome: "created" as const, sha256: sha256Hex(text), text, roots: sharedRoots };
  }

  if (sameConfig(current, text)) {
    return { outcome: "unchanged" as const, sha256: sha256Hex(current), roots: sharedRoots };
  }

  if (recorded === sha256Hex(current)) {
    return { outcome: "updated" as const, sha256: sha256Hex(text), text, current, roots: sharedRoots };
  }

  return conflictPlan(parsed, file, { text, current, roots: sharedRoots }, recorded);
};

const KEEPS_FILE = new Set(["none", "kept", "unchanged"]);

const checkedPlan = async (deps: CliDeps, parsed: SeedArgs, plan: Plan | { rejected: string }) => {
  if ("rejected" in plan || !parsed.check || !KEEPS_FILE.has(plan.outcome)) {
    return plan;
  }

  try {
    await assertValidFile(pathsOf(deps).userConfigFile);

    return plan;
  } catch (error) {
    return rejection(errorMessage(error));
  }
};

const rootsPlan = async (deps: CliDeps, roots: string[]): Promise<Plan | { rejected: string }> => {
  if (roots.length === 0) {
    return { outcome: "none" };
  }

  try {
    return { outcome: await plannedRootsOutcome(deps, roots) };
  } catch (error) {
    return rejection(errorMessage(error));
  }
};

const planOf = (deps: CliDeps, parsed: SeedArgs) => {
  if (parsed.from !== undefined) {
    return seedPlan(
      deps,
      parsed,
      parsed.from,
      parsed.roots.map((root) => storedRoot(deps, root)),
    );
  }

  if (!parsed.check) {
    throw new LauncherError(`${SEED_CONFIG} needs --from, or --check`);
  }

  return rootsPlan(deps, parsed.roots);
};

const written = async (file: string, text: string) => {
  if (!(await writeNewFile(file, text, { mode: CONFIG_MODE }))) {
    throw new LauncherError(`${file} appeared while the installer wrote it`, "run the install command again");
  }
};

const writeTarget = (file: string) => realpath(file).catch(() => file);

const apply = async (file: string, plan: Plan) => {
  const proposed = proposedConfigFile(file);
  const text = plan.text ?? "";

  if (plan.outcome === "kept") {
    await writeFileAtomic(proposed, text, { mode: CONFIG_MODE });

    return;
  }

  if (plan.outcome === "created") {
    await written(file, text);
  }

  if (plan.outcome === "replaced") {
    await writeFileAtomic(backupConfigFile(file), plan.current ?? "", { mode: CONFIG_MODE });
  }

  if (plan.outcome === "updated" || plan.outcome === "replaced") {
    await writeFileAtomic(await writeTarget(file), text, { mode: CONFIG_MODE });
  }

  await rm(proposed, { force: true });
};

export const seedConfigCommand = async (deps: CliDeps, args: string[]) => {
  const parsed = parseSeedArgs(args);
  const plan = await checkedPlan(deps, parsed, await planOf(deps, parsed));

  if ("rejected" in plan) {
    writeLine(deps.stderr, `pi-sandbox: ${plan.rejected}`);

    return CONFIG_REJECTED_EXIT;
  }

  if (!parsed.check) {
    await apply(pathsOf(deps).userConfigFile, plan);
  }

  writeLines(deps.stdout, [`${plan.outcome} ${plan.sha256 ?? "-"}`, ...(plan.roots ?? [])]);

  return 0;
};
