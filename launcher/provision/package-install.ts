import { stripVTControlCharacters } from "node:util";
import { type Backend, execCapture } from "../backend/index.ts";
import { errorMessage, readJsonObject, sha256Hex, writeJsonFile } from "../shared/index.ts";
import { isRemoteSource, withoutSourceCredential } from "./package-source.ts";
import type { PackageChanges } from "./types.ts";

interface ListedPackage {
  source: string;
  installed: boolean;
}

interface PiPackageList {
  user: ListedPackage[];
  project: ListedPackage[];
}

interface PackageInstallInput {
  backend: Backend;
  containerId: string;
  env: Record<string, string>;
  packages?: PackageChanges;
  failedPath: string;
  offline: boolean;
  announce: (notice: string) => void;
  listTimeoutMs?: number;
  installTimeoutMs?: number;
}

type Section = keyof PiPackageList;

const HEADERS: Record<string, Section> = { "User packages:": "user", "Project packages:": "project" };

const EMPTY_LIST = "No packages installed.";

const ENTRY = /^ {2}(\S.*)$/;

const INSTALLED_PATH = /^ {4}\S/;

const FILTERED = " (filtered)";

const LIST_SECONDS = 60;

const INSTALL_SECONDS = 600;

const HOST_GRACE_MS = 30_000;

const TIMED_OUT_EXITS = new Set([124, 137]);

const REASON_LENGTH = 200;

const OFFLINE_VALUES = new Set(["1", "true", "yes"]);

const PRIVATE_FILE_MODE = 0o600;

const inContainer = (seconds: number, command: string[]) => [
  "timeout",
  "-k",
  "10",
  String(seconds),
  "pi",
  ...command,
];

export const LIST_COMMAND = inContainer(LIST_SECONDS, ["list"]);

export const INSTALL_COMMAND = inContainer(INSTALL_SECONDS, ["--help"]);

const plainLines = (text: string) => stripVTControlCharacters(text).split(/\r?\n/);

const entrySource = (line: string) => {
  const source = ENTRY.exec(line)?.[1]?.trimEnd();

  return source?.endsWith(FILTERED) === true ? source.slice(0, -FILTERED.length) : source;
};

export const parsePiList = (text: string): PiPackageList | undefined => {
  const lines = plainLines(text);
  const list: PiPackageList = { user: [], project: [] };
  const state: { section?: Section; seen: boolean } = {
    seen: lines.some((line) => line.trim() === EMPTY_LIST),
  };

  lines.forEach((line) => {
    const header = HEADERS[line.trim()];

    if (header !== undefined) {
      state.section = header;

      state.seen = true;

      return;
    }

    const entries = state.section === undefined ? undefined : list[state.section];

    if (entries === undefined) {
      return;
    }

    if (INSTALLED_PATH.test(line)) {
      const last = entries.at(-1);

      if (last !== undefined) {
        last.installed = true;
      }

      return;
    }

    const source = entrySource(line);

    if (source !== undefined) {
      entries.push({ source, installed: false });
    }
  });

  return state.seen ? list : undefined;
};

export const isPiOffline = (env: Record<string, string | undefined>, piArgs: readonly string[]) =>
  OFFLINE_VALUES.has((env.PI_OFFLINE ?? "").trim().toLowerCase()) || piArgs.includes("--offline");

const missingSources = (list: PiPackageList) =>
  list.user.filter((entry) => isRemoteSource(entry.source) && !entry.installed).map((entry) => entry.source);

const updatedSources = (changed: readonly string[], missing: readonly string[]) =>
  changed.filter(
    (identity) =>
      identity.startsWith("npm:") &&
      !missing.some((source) => source === identity || source.startsWith(`${identity}@`)),
  );

const shownSource = (source: string) => withoutSourceCredential(source)?.source ?? source;

const scrubbed = (text: string) => text.replace(/:\/\/[^/\s@]*@/g, "://");

const shortened = (text: string) =>
  text.length > REASON_LENGTH ? `${text.slice(0, REASON_LENGTH - 1)}…` : text;

const FAILURE = /failed to install \((.*)\)\.(?: Run| Check|$)/;

const failureReason = (stderr: string, source: string) => {
  const line = plainLines(stderr).find((text) => text.includes(source) && FAILURE.test(text));
  const reason = line === undefined ? undefined : FAILURE.exec(line)?.[1];

  return reason === undefined || reason.trim() === "" ? undefined : shortened(scrubbed(reason.trim()));
};

const installingNotice = (count: number) =>
  `installing ${count} ${count === 1 ? "extension" : "extensions"} in the shared pi folder; this can take a few minutes`;

const stillMissingNotice = (source: string, reason: string | undefined) =>
  `warning: ${shownSource(source)} could not be installed in the shared pi folder${reason === undefined ? "" : ` (${reason})`}; pi tries again when it starts`;

const skippedNotice = (source: string) =>
  `warning: ${shownSource(source)} could not be installed in the shared pi folder last time, so the launcher did not try again; pi tries when it starts`;

const listFailedNotice = (reason: string) =>
  `warning: the extensions in the shared pi folder were not checked (${reason}); pi installs what is missing when it starts`;

const installFailedNotice = (reason: string) =>
  `warning: the extensions were not installed in the shared pi folder (${reason}); pi tries again when it starts`;

class NoticeError extends Error {}

const runPi = (input: PackageInstallInput, command: string[], timeoutMs: number) =>
  execCapture(
    input.backend,
    { containerId: input.containerId, command, env: input.env, workdir: "/" },
    "",
    timeoutMs,
  );

const listPackages = async (input: PackageInstallInput) => {
  const result = await runPi(input, LIST_COMMAND, input.listTimeoutMs ?? LIST_SECONDS * 1000 + HOST_GRACE_MS);

  if (TIMED_OUT_EXITS.has(result.code)) {
    throw new Error(`pi list did not finish within ${LIST_SECONDS} s`);
  }

  if (result.code !== 0) {
    throw new Error(`pi list exited with ${result.code}`);
  }

  const list = parsePiList(result.stdout);

  if (list === undefined) {
    throw new Error("pi list printed nothing the launcher understands");
  }

  return list;
};

const install = async (input: PackageInstallInput) => {
  const result = await runPi(
    input,
    INSTALL_COMMAND,
    input.installTimeoutMs ?? INSTALL_SECONDS * 1000 + HOST_GRACE_MS,
  );

  if (TIMED_OUT_EXITS.has(result.code)) {
    throw new Error(`pi did not finish within ${INSTALL_SECONDS / 60} minutes`);
  }

  if (result.code !== 0) {
    throw new Error(`pi exited with ${result.code}`);
  }

  return result.stderr;
};

const hasNothingToCheck = (packages: PackageChanges | undefined) =>
  packages !== undefined && !packages.sources.some(isRemoteSource);

const identityOf = (source: string) => sha256Hex(source);

const readFailed = async (path: string) => {
  const failed = (await readJsonObject(path))?.failed;

  return new Set(Array.isArray(failed) ? failed.filter((entry) => typeof entry === "string") : []);
};

const rememberFailed = (path: string, recorded: ReadonlySet<string>, sources: readonly string[]) => {
  const failed = [...new Set(sources.map(identityOf))].sort();
  const unchanged = failed.length === recorded.size && failed.every((identity) => recorded.has(identity));

  return unchanged
    ? Promise.resolve()
    : writeJsonFile(path, { failed }, { mode: PRIVATE_FILE_MODE }).catch(() => undefined);
};

const installMissing = async (input: PackageInstallInput) => {
  const before = await listPackages(input).catch((error: unknown) => {
    throw new NoticeError(listFailedNotice(errorMessage(error)));
  });
  const missing = missingSources(before);
  const recorded = await readFailed(input.failedPath);
  const skipped = missing.filter((source) => recorded.has(identityOf(source)));
  const tried = missing.filter((source) => !skipped.includes(source));
  const updated = updatedSources(input.packages?.changed ?? [], missing);

  if (tried.length + updated.length === 0) {
    await rememberFailed(input.failedPath, recorded, skipped);

    return skipped.map(skippedNotice);
  }

  input.announce(installingNotice(tried.length + updated.length));

  const stderr = await install(input).catch(async (error: unknown) => {
    await rememberFailed(input.failedPath, recorded, missing);

    throw new NoticeError(installFailedNotice(errorMessage(error)));
  });

  if (missing.length === 0) {
    await rememberFailed(input.failedPath, recorded, []);

    return [];
  }

  const after = await listPackages(input).catch(async (error: unknown) => {
    await rememberFailed(input.failedPath, recorded, missing);

    throw new NoticeError(listFailedNotice(errorMessage(error)));
  });
  const still = missingSources(after);

  await rememberFailed(input.failedPath, recorded, still);

  return still.map((source) =>
    skipped.includes(source)
      ? skippedNotice(source)
      : stillMissingNotice(source, failureReason(stderr, source)),
  );
};

export const installPackages = async (input: PackageInstallInput): Promise<string[]> => {
  if (input.offline || hasNothingToCheck(input.packages)) {
    return [];
  }

  return installMissing(input).catch((error: unknown) =>
    error instanceof NoticeError ? [error.message] : [installFailedNotice(errorMessage(error))],
  );
};
