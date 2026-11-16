import { readFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { isWithin, LauncherError } from "../../shared/index.ts";
import type { VmCoverage, VmPath, VmShare } from "../types.ts";
import { shareDrift } from "../vm-decision.ts";
import { movedMountsOf, vmSharesOf } from "./colima-yaml.ts";
import { type Colima, instanceOf, restartText } from "./profile.ts";

export const UNREADABLE =
  "the shares of the sandbox VM could not be read from colima's lima.yaml, so they were not changed";

const segmentsOf = (path: string) => path.split(sep).filter((part) => part !== "");

export const shareFor = (path: string, home: string) => {
  if (isWithin(path, home)) {
    return home;
  }

  const [top, volume] = segmentsOf(path);
  const candidate = top === "Volumes" && volume !== undefined ? join(sep, top, volume) : dirname(path);
  const shallow = segmentsOf(candidate).length < 2;

  return shallow || isWithin(home, candidate) ? path : candidate;
};

const readOptional = (path: string) => readFile(path, "utf8").catch(() => undefined);

const covers = (shares: VmShare[], need: VmPath) =>
  shares.some((share) => isWithin(need.path, share.location) && (share.writable || !need.writable));

const uncovered = (shares: VmShare[], needs: VmPath[]) => needs.filter((need) => !covers(shares, need));

const pathsOf = (needs: VmPath[]) => {
  const paths = [...new Set(needs.map((need) => need.path))];

  return paths.filter((path) => !paths.some((other) => other !== path && isWithin(path, other)));
};

const merged = (shares: VmShare[]) =>
  [...new Set(shares.map((share) => share.location))]
    .filter(
      (location) =>
        !shares.some((other) => other.location !== location && isWithin(location, other.location)),
    )
    .map((location) => ({
      location,
      writable: shares.some((share) => share.writable && isWithin(share.location, location)),
    }));

const homeFirst = (shares: VmShare[], home: string) => [
  ...shares.filter((share) => share.location === home),
  ...shares.filter((share) => share.location !== home),
];

const mountableShares = (shares: VmShare[], home: string) => homeFirst(merged(shares), home);

const colimaYaml = (profile: string) => `~/.colima/${profile}/colima.yaml`;

const editHint = (profile: string) => `edit ${colimaYaml(profile)} mounts, then ${restartText(profile)}`;

export const locationsOf = (shares: VmShare[]) => shares.map((share) => share.location).join(", ");

export const notShared = (paths: string[]) =>
  `${paths.join(", ")} ${paths.length === 1 ? "is" : "are"} not shared with the sandbox VM`;

export const uncoveredPaths = (shares: VmShare[], needs: VmPath[]) => pathsOf(uncovered(shares, needs));

export const sharesFor = (current: VmShare[], needs: VmPath[], home: string) =>
  uncovered(current, needs).map((need) => ({ location: shareFor(need.path, home), writable: need.writable }));

export const restartedShares = (
  current: VmShare[] | "unreadable",
  wanted: VmShare[],
  exact: boolean,
  home: string,
) =>
  mountableShares(
    exact || current === "unreadable" ? wanted : [...current, ...shareDrift(current, wanted).lacking],
    home,
  );

export const assertDesiredCovers = (desired: VmShare[], needs: VmPath[]) => {
  const outside = uncoveredPaths(desired, needs);

  if (outside.length > 0) {
    throw new LauncherError(
      `${outside.join(", ")} ${outside.length === 1 ? "lies" : "lie"} outside the shares workspaceRoots gives the sandbox VM`,
      "start pi inside one of the workspaceRoots, or add the folder to workspaceRoots.roots",
    );
  }
};

export const createColimaShares = (colima: Colima) => {
  const { home, profile } = colima;

  const limaYaml = () => readOptional(join(home, ".colima", "_lima", instanceOf(profile), "lima.yaml"));

  const readShares = async () => {
    const text = await limaYaml();

    if (text === undefined) {
      return undefined;
    }

    return vmSharesOf(text, home) ?? "unreadable";
  };

  const assertShared = async (added: VmShare[], needs: VmPath[], mounts: VmShare[]) => {
    const shares = await readShares();
    const missing = Array.isArray(shares)
      ? uncoveredPaths(shares, needs)
      : added.map((share) => share.location);

    if (missing.length > 0) {
      throw new LauncherError(
        `colima did not share ${missing.join(", ")} with the sandbox VM`,
        `run ${restartText(profile, { shares: mounts })}`,
      );
    }
  };

  const keepsMoved = async (problem: string) => {
    const moved = movedMountsOf((await limaYaml()) ?? "", home);

    if (moved.length > 0) {
      throw new LauncherError(
        `${problem}; ${moved.join(", ")} ${moved.length === 1 ? "is" : "are"} mounted at another path in the VM, which colima's --mount cannot keep`,
        editHint(profile),
      );
    }
  };

  const coverage = async (needs: VmPath[]): Promise<VmCoverage | "unreadable" | undefined> => {
    const shares = await readShares();

    if (shares === undefined || shares === "unreadable") {
      return shares;
    }

    return { shares, missing: uncoveredPaths(shares, needs) };
  };

  return { coverage, readShares, keepsMoved, assertShared };
};
