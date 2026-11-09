import { userHashOf } from "../../container/index.ts";
import { LauncherError } from "../../shared/index.ts";
import { type CliDeps, pathsOf, writeLine, writeLines } from "../deps.ts";
import { openContext } from "../launch.ts";
import { sweepOrphans } from "../sweep.ts";

const SHARED_CACHES = "--shared-caches";

const sharedOwnerOf = (args: string[], stateDir: string) => {
  const unknown = args.find((arg) => arg !== SHARED_CACHES);

  if (unknown !== undefined) {
    throw new LauncherError(`unknown gc option "${unknown}"`, `pi sandbox gc [${SHARED_CACHES}]`);
  }

  return args.includes(SHARED_CACHES) ? userHashOf(stateDir) : undefined;
};

export const gcCommand = async (deps: CliDeps, args: string[]) => {
  const sharedOwner = sharedOwnerOf(args, pathsOf(deps).stateDir);
  const { backend } = await openContext(deps, "admin");
  const lines = await sweepOrphans(deps, backend, { collect: { sharedOwner } });

  writeLines(deps.stdout, lines);

  writeLine(deps.stdout, lines.length === 0 ? "nothing to remove" : `done, ${lines.length} removed`);

  return 0;
};
