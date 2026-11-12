import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import type { JsonObject } from "../hostpi/index.ts";
import { isJsonObject, parseJsonObject } from "../shared/index.ts";
import { sourceOfEntry } from "./package-source.ts";

export interface PackagePin {
  identity: string;
  value: string;
  guestDir?: string;
}

export interface PinnedPackages {
  packages: unknown[];
  pins: PackagePin[];
}

const NPM_SPEC = /^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/;

const NPM_NAME = /^(?:@[a-z0-9~][\w.~-]*\/)?[a-z0-9~][\w.~-]*$/i;

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

const SYMBOLIC_REF = /^ref: (refs\/\S+)$/;

const GIT_PROTOCOL = /^(?:https?|ssh|git):\/\//i;

const SCP_LIKE = /^git@[^:/]+:/;

const GIT_LOCATION_PART = /^[A-Za-z0-9._-]+$/;

const readText = (path: string) => readFile(path, "utf8").catch(() => undefined);

const isSafePart = (part: string) =>
  part !== "" && part !== "." && part !== ".." && !part.includes("\0") && !part.includes("\\");

const isLocationPart = (part: string) => GIT_LOCATION_PART.test(part) && part !== "." && part !== "..";

export const isVolumeGitDir = (dir: string) => {
  const [root, host, ...path] = dir.split("/");

  return (
    root === "git" &&
    host !== undefined &&
    isLocationPart(host) &&
    path.length >= 2 &&
    path.every(isLocationPart)
  );
};

const hostVersion = async (hostAgentDir: string, name: string) => {
  const text = await readText(join(hostAgentDir, "npm", "node_modules", ...name.split("/"), "package.json"));
  const manifest = text === undefined ? undefined : parseJsonObject(text);
  const version = isJsonObject(manifest) ? manifest.version : undefined;

  return typeof version === "string" && EXACT_VERSION.test(version) ? version : undefined;
};

const npmPin = async (source: string, hostAgentDir: string) => {
  const name = NPM_SPEC.exec(source.slice("npm:".length).trim())?.[1];

  if (name === undefined || !NPM_NAME.test(name)) {
    return undefined;
  }

  const version = await hostVersion(hostAgentDir, name);

  return version === undefined
    ? undefined
    : { source: `npm:${name}@${version}`, pin: { identity: `npm:${name}`, value: version } };
};

const pathStart = (url: string) => {
  if (SCP_LIKE.test(url)) {
    return url.indexOf(":") + 1;
  }

  const authority = GIT_PROTOCOL.test(url) ? url.indexOf("://") + 3 : 0;
  const slash = url.indexOf("/", authority);

  return slash < 0 ? -1 : slash + 1;
};

const withoutRef = (url: string, start: number) => {
  const at = url.indexOf("@", start);

  return at < 0 ? url : url.slice(0, at);
};

const hostOf = (repo: string, start: number) => {
  if (SCP_LIKE.test(repo)) {
    return repo.slice("git@".length, start - 1);
  }

  if (GIT_PROTOCOL.test(repo)) {
    return URL.canParse(repo) ? new URL(repo).hostname : "";
  }

  return repo.slice(0, start - 1);
};

const gitLocation = (url: string) => {
  const start = pathStart(url);

  if (start <= 0) {
    return undefined;
  }

  const repo = withoutRef(url, start);
  const host = hostOf(repo, start);
  const path = repo
    .slice(start)
    .replace(/^\/+/, "")
    .replace(/\.git$/, "");
  const parts = path.split("/");

  if (!isLocationPart(host) || parts.length < 2 || !parts.every(isLocationPart)) {
    return undefined;
  }

  return { repo, host, path };
};

const packedRef = (packed: string | undefined, ref: string) =>
  (packed ?? "")
    .split("\n")
    .map((line) => line.trim().split(" "))
    .find(([sha, name]) => name === ref && COMMIT.test(sha ?? ""))?.[0];

const checkoutHead = async (checkout: string) => {
  const head = (await readText(join(checkout, ".git", "HEAD")))?.trim() ?? "";

  if (COMMIT.test(head)) {
    return head;
  }

  const ref = SYMBOLIC_REF.exec(head)?.[1];

  if (ref === undefined || !ref.split("/").every(isSafePart)) {
    return undefined;
  }

  const loose = (await readText(join(checkout, ".git", ...ref.split("/"))))?.trim();

  return loose !== undefined && COMMIT.test(loose)
    ? loose
    : packedRef(await readText(join(checkout, ".git", "packed-refs")), ref);
};

const gitSource = async (url: string, hostAgentDir: string) => {
  const location = gitLocation(url);

  if (location === undefined) {
    return undefined;
  }

  const head = await checkoutHead(join(hostAgentDir, "git", location.host, ...location.path.split("/")));

  return head === undefined ? undefined : { ...location, head };
};

const gitPin = async (source: string, hostAgentDir: string) => {
  const prefix = source.startsWith("git:") ? "git:" : "";
  const url = source.slice(prefix.length).trim();

  if (prefix === "" && !GIT_PROTOCOL.test(url)) {
    return undefined;
  }

  const git = await gitSource(url, hostAgentDir);

  return git === undefined
    ? undefined
    : {
        source: `${prefix}${git.repo}@${git.head}`,
        pin: {
          identity: `git:${git.host}/${git.path}`,
          value: git.head,
          guestDir: posix.join("git", git.host, git.path),
        },
      };
};

const pinOf = (source: string, hostAgentDir: string) =>
  source.startsWith("npm:") ? npmPin(source, hostAgentDir) : gitPin(source, hostAgentDir);

const pinnedEntry = (entry: unknown, source: string) =>
  typeof entry === "string" ? source : { ...(entry as JsonObject), source };

export const pinHostPackages = async (packages: unknown[], hostAgentDir: string): Promise<PinnedPackages> => {
  const outcomes = await Promise.all(
    packages.map(async (entry) => {
      const source = sourceOfEntry(entry);
      const pinned = source === undefined ? undefined : await pinOf(source, hostAgentDir);

      return pinned === undefined ? { entry } : { entry: pinnedEntry(entry, pinned.source), pin: pinned.pin };
    }),
  );

  return {
    packages: outcomes.map((outcome) => outcome.entry),
    pins: outcomes.flatMap((outcome) => (outcome.pin === undefined ? [] : [outcome.pin])),
  };
};
