import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isWithin, LauncherError, outermostPaths } from "../../shared/index.ts";
import type { VmCoverage, VmPath, VmShare } from "../types.ts";
import { vmSharesOf } from "./colima-yaml.ts";
import { type Colima, instanceOf, restartText } from "./profile.ts";

export const UNREADABLE =
  "the shares of the sandbox VM could not be read from colima's lima.yaml, so they were not changed";

const readOptional = (path: string) => readFile(path, "utf8").catch(() => undefined);

const covers = (shares: VmShare[], need: VmPath) =>
  shares.some(
    (share) =>
      share.mountPoint === undefined &&
      isWithin(need.path, share.location) &&
      (share.writable || !need.writable),
  );

const uncovered = (shares: VmShare[], needs: VmPath[]) => needs.filter((need) => !covers(shares, need));

const pathsOf = (needs: VmPath[]) => outermostPaths(needs.map((need) => need.path));

export const locationsOf = (shares: VmShare[]) => shares.map((share) => share.location).join(", ");

export const notShared = (paths: string[]) =>
  `${paths.join(", ")} ${paths.length === 1 ? "is" : "are"} not shared with the sandbox VM`;

export const uncoveredPaths = (shares: VmShare[], needs: VmPath[]) => pathsOf(uncovered(shares, needs));

export const assertDesiredCovers = (desired: VmShare[], needs: VmPath[]) => {
  const outside = uncoveredPaths(desired, needs);

  if (outside.length > 0) {
    throw new LauncherError(
      `${outside.join(", ")} ${outside.length === 1 ? "lies" : "lie"} outside the shares workspaceRoot gives the sandbox VM`,
      "start pi inside the workspace root, or point workspaceRoot at a folder that holds the project",
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

  const coverage = async (needs: VmPath[]): Promise<VmCoverage | "unreadable" | undefined> => {
    const shares = await readShares();

    if (shares === undefined || shares === "unreadable") {
      return shares;
    }

    return { shares, missing: uncoveredPaths(shares, needs) };
  };

  return { coverage, readShares, assertShared };
};
