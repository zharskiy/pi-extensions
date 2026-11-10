import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import {
  type CommandRunner,
  errorMessage,
  expandHome,
  LauncherError,
  lstatOrUndefined,
} from "../../shared/index.ts";
import { realOrPending, unique } from "../paths.ts";
import { inertGitOptions } from "./command.ts";

interface GitInclude {
  origin: string;
  path: string;
}

export interface GitConfigListing {
  files: string[];
  includes: GitInclude[];
  hooksPath?: string;
  worktreeConfig: boolean;
}

interface ConfigEntry {
  scope: string;
  file?: string;
  key: string;
  value?: string;
}

const FILE_ORIGIN = "file:";

const MISSING_GIT = "git: command not found";

const COMMAND_SCOPE = "command";

const INCLUDE_KEY = /^include\.path$|^includeif\..*\.path$/;

const TRUE_WORDS = new Set(["true", "yes", "on"]);

export const EMPTY_GIT_CONFIG: GitConfigListing = { files: [], includes: [], worktreeConfig: false };

const entriesOf = (cwd: string, stdout: string): ConfigEntry[] => {
  const fields = stdout.split("\0");

  return Array.from({ length: Math.floor(fields.length / 3) }, (_, index) => {
    const origin = fields[index * 3 + 1] ?? "";
    const pair = fields[index * 3 + 2] ?? "";
    const newline = pair.indexOf("\n");

    return {
      scope: fields[index * 3] ?? "",
      ...(origin.startsWith(FILE_ORIGIN) ? { file: resolve(cwd, origin.slice(FILE_ORIGIN.length)) } : {}),
      key: (newline < 0 ? pair : pair.slice(0, newline)).toLowerCase(),
      ...(newline < 0 ? {} : { value: pair.slice(newline + 1) }),
    };
  }).filter((entry) => entry.scope !== COMMAND_SCOPE);
};

const isTrue = (value: string | undefined) => {
  if (value === undefined) {
    return true;
  }

  const word = value.trim().toLowerCase();

  return TRUE_WORDS.has(word) || (/^-?\d+$/.test(word) && Number(word) !== 0);
};

const lastValue = (entries: ConfigEntry[], key: string) =>
  entries.filter((entry) => entry.key === key).at(-1);

const FOREIGN_PATH = /^~[^/]|^%\(prefix\)\//;

export const isForeignPath = (value: string) => FOREIGN_PATH.test(value);

const includeOf = (origin: string, key: string, value: string | undefined, home: string) =>
  INCLUDE_KEY.test(key) && value !== undefined && value !== "" && !isForeignPath(value)
    ? [{ origin, path: resolve(dirname(origin), expandHome(value, home)) }]
    : [];

const includesOf = (entries: ConfigEntry[], home: string) =>
  entries.flatMap((entry) =>
    entry.file === undefined ? [] : includeOf(entry.file, entry.key, entry.value, home),
  );

const parsedListing = async (cwd: string, stdout: string, home: string): Promise<GitConfigListing> => {
  const entries = entriesOf(cwd, stdout);
  const files = unique(entries.flatMap((entry) => (entry.file === undefined ? [] : [entry.file])));
  const real = await Promise.all(files.map((file) => realpath(file).catch(() => file)));
  const hooksPath = lastValue(entries, "core.hookspath")?.value;
  const worktreeConfig = lastValue(
    entries.filter((entry) => entry.scope === "local"),
    "extensions.worktreeconfig",
  );

  return {
    files: unique([...files, ...real]),
    includes: includesOf(entries, home),
    ...(hooksPath === undefined || hooksPath === "" ? {} : { hooksPath }),
    worktreeConfig: worktreeConfig !== undefined && isTrue(worktreeConfig.value),
  };
};

const listingRefusal = (cwd: string, stderr: string) =>
  new LauncherError(`git: could not list the git configuration of ${cwd}: ${stderr.trim()}`);

interface ListingOptions {
  home?: string;
  withoutGit?: "empty" | "refuse";
}

const listed = (cwd: string, args: string[], runner: CommandRunner, emptyHooksDir: string) =>
  runner
    .run("git", [...inertGitOptions(emptyHooksDir), "config", ...args], { cwd })
    .catch((error: unknown) =>
      errorMessage(error) === MISSING_GIT ? undefined : { code: -1, stdout: "", stderr: errorMessage(error) },
    );

export const readGitConfig = async (
  cwd: string,
  runner: CommandRunner,
  emptyHooksDir: string,
  options: ListingOptions = {},
): Promise<GitConfigListing> => {
  const result = await listed(cwd, ["--list", "--show-origin", "--show-scope", "-z"], runner, emptyHooksDir);

  if (result === undefined && options.withoutGit === "empty") {
    return EMPTY_GIT_CONFIG;
  }

  if (result === undefined || result.code !== 0) {
    throw listingRefusal(cwd, result?.stderr ?? MISSING_GIT);
  }

  return parsedListing(cwd, result.stdout, options.home ?? homedir());
};

interface IncludedFile extends GitInclude {
  real: string;
}

const includedFiles = (listing: GitConfigListing): Promise<IncludedFile[]> =>
  Promise.all(
    listing.includes.map(async (include) => ({ ...include, real: await realOrPending(include.path) })),
  );

const shellWord = (path: string) =>
  /^[\w./@%+=:,-]+$/.test(path) ? path : `'${path.replaceAll("'", "'\\''")}'`;

export const missingInclude = (include: GitInclude) =>
  new LauncherError(
    `git: ${include.origin} includes ${include.path}, which does not exist; the sandbox could create it with settings host git would then run`,
    `create it empty with touch ${shellWord(include.path)} (an empty file changes nothing for git), or remove the include from ${include.origin}`,
  );

export const missingWorktreeConfig = (path: string) =>
  new LauncherError(
    `git: ${path} is missing; extensions.worktreeConfig (which git sparse-checkout turns on) makes git read it, so the sandbox could create it with settings host git would then run`,
    `create it empty with touch ${shellWord(path)} (an empty file changes nothing for git)`,
  );

interface ConfigFiles {
  files: string[];
  included: IncludedFile[];
  missing: IncludedFile[];
}

export const configFilesOf = async (listing: GitConfigListing, own: string[] = []): Promise<ConfigFiles> => {
  const included = await includedFiles(listing);
  const present = await Promise.all(
    included.map(async (file) => (await lstatOrUndefined(file.path)) !== undefined),
  );
  const found = included.flatMap((file, index) => (present[index] ? [file.path, file.real] : []));

  return {
    files: unique([...listing.files, ...found]).filter((file) => !own.includes(file)),
    included,
    missing: included.filter((_, index) => !present[index]),
  };
};

export interface HooksPathValue {
  value: string;
  origin: string;
  base?: string | null;
}

export interface ConfigSource {
  file: string;
  base?: string | null;
  worktreeFromFile?: boolean;
}

interface ClosureOptions {
  runner: CommandRunner;
  emptyHooksDir: string;
  home: string;
}

export interface ConfigClosure {
  includes: GitInclude[];
  hooksPaths: HooksPathValue[];
}

const pairsOf = (stdout: string) =>
  stdout
    .split("\0")
    .filter((field) => field !== "")
    .map((field) => {
      const newline = field.indexOf("\n");

      return newline < 0
        ? { key: field.toLowerCase() }
        : { key: field.slice(0, newline).toLowerCase(), value: field.slice(newline + 1) };
    });

const baseOf = (source: ConfigSource, pairs: { key: string; value?: string }[]) => {
  if (source.worktreeFromFile !== true) {
    return source.base;
  }

  const worktree = pairs.filter((pair) => pair.key === "core.worktree").at(-1)?.value;

  return worktree === undefined || worktree === "" ? null : resolve(dirname(source.file), worktree);
};

interface FileListing extends ConfigClosure {
  base?: string | null;
}

const listFile = async (source: ConfigSource, options: ClosureOptions): Promise<FileListing> => {
  const args = ["--file", source.file, "--no-includes", "--list", "-z"];
  const result = await listed(dirname(source.file), args, options.runner, options.emptyHooksDir);

  if (result === undefined) {
    return { includes: [], hooksPaths: [], ...(source.base === undefined ? {} : { base: source.base }) };
  }

  if (result.code !== 0) {
    throw listingRefusal(source.file, result.stderr);
  }

  const pairs = pairsOf(result.stdout);
  const base = baseOf(source, pairs);

  return {
    ...(base === undefined ? {} : { base }),
    includes: pairs.flatMap((pair) => includeOf(source.file, pair.key, pair.value, options.home)),
    hooksPaths: pairs.flatMap((pair) =>
      pair.key === "core.hookspath" && pair.value !== undefined && pair.value !== ""
        ? [{ value: pair.value, origin: source.file, ...(base === undefined ? {} : { base }) }]
        : [],
    ),
  };
};

const isFile = async (path: string) => (await lstatOrUndefined(path))?.isFile() === true;

const closureOf = async (
  sources: ConfigSource[],
  visited: Set<string>,
  options: ClosureOptions,
  found: ConfigClosure,
): Promise<ConfigClosure> => {
  if (sources.length === 0) {
    return found;
  }

  const seen = new Set([...visited, ...sources.map((source) => source.file)]);

  const listings = await Promise.all(sources.map((source) => listFile(source, options)));
  const candidates = listings.flatMap((listing) =>
    listing.includes.map((include) => ({ file: include.path, base: listing.base })),
  );
  const fresh = candidates.filter(
    (candidate, index) =>
      !visited.has(candidate.file) &&
      candidates.findIndex((other) => other.file === candidate.file) === index,
  );
  const present = await Promise.all(fresh.map((candidate) => isFile(candidate.file)));

  return closureOf(
    fresh
      .filter((_, index) => present[index])
      .map((candidate) => ({
        file: candidate.file,
        ...(candidate.base === undefined ? {} : { base: candidate.base }),
      })),
    seen,
    options,
    {
      includes: [...found.includes, ...listings.flatMap((listing) => listing.includes)],
      hooksPaths: [...found.hooksPaths, ...listings.flatMap((listing) => listing.hooksPaths)],
    },
  );
};

export const configClosure = async (
  listing: GitConfigListing,
  extra: ConfigSource[],
  options: ClosureOptions,
): Promise<ConfigClosure> => {
  const unread = listing.includes.filter((include) => !listing.files.includes(include.path));
  const present = await Promise.all(unread.map((include) => isFile(include.path)));
  const extraPresent = await Promise.all(extra.map((source) => isFile(source.file)));
  const sources = [
    ...unread.filter((_, index) => present[index]).map((include) => ({ file: include.path })),
    ...extra.filter((source, index) => extraPresent[index] && !listing.files.includes(source.file)),
  ];

  return closureOf(
    sources.filter((source, index) => sources.findIndex((other) => other.file === source.file) === index),
    new Set(listing.files),
    options,
    { includes: [], hooksPaths: [] },
  );
};
