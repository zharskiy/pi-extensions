import { join, resolve } from "node:path";
import { carryChangelogMarker, packageIdentity, sourceOfEntry } from "../../provision/index.ts";
import { LauncherError, PI_AGENT_DIR_VARIABLE, readJsonObject, withMcpLoginDir } from "../../shared/index.ts";
import { type CliDeps, hostAgentDirOf, pathsOf, writeLine } from "../deps.ts";
import { requireJobPi } from "../host-pi.ts";
import { PACKAGE_NAME, readReceipt } from "../install-receipt.ts";
import { launcherRepository } from "../versions.ts";

export const EXTENSIONS = "__extensions";

const STEP_FAILED_EXIT = 70;

const LEGACY_PACKAGE_NAME = "pi-extensions-mz";

const OUR_PACKAGE_NAMES = new Set([PACKAGE_NAME, LEGACY_PACKAGE_NAME]);

export const hostPackageSources = async (deps: CliDeps) => {
  const settings = await readJsonObject(join(hostAgentDirOf(deps), "settings.json"));
  const packages = Array.isArray(settings?.packages) ? settings.packages : [];

  return packages.flatMap((entry) => {
    const source = sourceOfEntry(entry);

    return source === undefined ? [] : [source];
  });
};

const identitiesOfThisPackage = async (deps: CliDeps) => {
  const previous = (await readReceipt(pathsOf(deps).stateDir))?.extensions?.source;
  const repository = await launcherRepository();
  const sources = [`npm:${PACKAGE_NAME}`, `npm:${LEGACY_PACKAGE_NAME}`, previous, repository];

  return new Set(
    sources.flatMap((source) => {
      const identity = source === undefined ? undefined : packageIdentity(source);

      return identity === undefined ? [] : [identity];
    }),
  );
};

const localPathOf = (deps: CliDeps, source: string) => {
  const path = source.trim();

  if (path === "~") {
    return deps.home;
  }

  return path.startsWith("~/") ? join(deps.home, path.slice(2)) : resolve(hostAgentDirOf(deps), path);
};

const isLocalCopyOfThisPackage = async (deps: CliDeps, source: string) => {
  if (source.startsWith("npm:") || packageIdentity(source) !== undefined) {
    return false;
  }

  const manifest = await readJsonObject(join(localPathOf(deps, source), "package.json")).catch(
    () => undefined,
  );

  return typeof manifest?.name === "string" && OUR_PACKAGE_NAMES.has(manifest.name);
};

const localCopiesOfThisPackage = async (deps: CliDeps, sources: string[]) => {
  const found = await Promise.all(sources.map((source) => isLocalCopyOfThisPackage(deps, source)));

  return sources.filter((_, index) => found[index]);
};

const runPi = async (deps: CliDeps, args: string[]) => {
  const pi = await requireJobPi(deps, EXTENSIONS);
  const env = { [PI_AGENT_DIR_VARIABLE]: hostAgentDirOf(deps) };

  return withMcpLoginDir(pathsOf(deps).stateDir, (cwd) =>
    deps.runner.spawnInteractive(pi.wrapper, args, { cwd, env, stdin: "ignore" }),
  );
};

const failedStep = (deps: CliDeps, command: string, source: string, code: number) => {
  writeLine(deps.stderr, `pi-sandbox: pi ${command} ${source} failed (exit ${code})`);

  return STEP_FAILED_EXIT;
};

const removeAll = async (deps: CliDeps, sources: string[]): Promise<number> => {
  const [source, ...rest] = sources;

  if (source === undefined) {
    return 0;
  }

  writeLine(deps.stdout, `removing ${source}, another source of ${PACKAGE_NAME}`);

  const code = await runPi(deps, ["remove", source]);

  return code === 0 ? removeAll(deps, rest) : failedStep(deps, "remove", source, code);
};

const installSource = async (deps: CliDeps, source: string) => {
  const identity = packageIdentity(source);

  if (identity === undefined) {
    throw new LauncherError(`${source} is not an npm: or git: package source`);
  }

  const ours = await identitiesOfThisPackage(deps);
  const configured = await hostPackageSources(deps);
  const remote = configured.filter((entry) => {
    const other = packageIdentity(entry);

    return other !== undefined && (other === identity || ours.has(other));
  });
  const local = await localCopiesOfThisPackage(deps, configured);
  const previous = [...remote, ...local];
  const others = remote.filter((entry) => packageIdentity(entry) !== identity);
  const removed = await removeAll(deps, [...others, ...local.map((entry) => localPathOf(deps, entry))]);

  if (removed !== 0) {
    return removed;
  }

  const code = await runPi(deps, ["install", source]);

  if (code !== 0) {
    return failedStep(deps, "install", source, code);
  }

  await carryChangelogMarker(hostAgentDirOf(deps), previous, source);

  return 0;
};

const removeRecorded = async (deps: CliDeps) => {
  const source = (await readReceipt(pathsOf(deps).stateDir))?.extensions?.source;

  if (source === undefined) {
    writeLine(deps.stdout, "no install receipt names an extensions source, nothing removed");

    return 0;
  }

  const code = await runPi(deps, ["remove", source]);

  if (code !== 0) {
    return failedStep(deps, "remove", source, code);
  }

  writeLine(deps.stdout, `removed ${source} from host pi`);

  return 0;
};

export const extensionsCommand = (deps: CliDeps, [action, source, ...rest]: string[]) => {
  if (action === "install" && source !== undefined && rest.length === 0) {
    return installSource(deps, source);
  }

  if (action === "remove" && source === undefined) {
    return removeRecorded(deps);
  }

  throw new LauncherError(`usage: ${EXTENSIONS} install <source> | ${EXTENSIONS} remove`);
};
