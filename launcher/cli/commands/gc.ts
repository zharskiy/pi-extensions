import { userHashOf } from "../../container/index.ts";
import { type CliDeps, pathsOf, writeLine, writeLines } from "../deps.ts";
import { sweepOrphans } from "../sweep.ts";

export const SHARED_CACHES = "--shared-caches";

const ENGINE_SKIPPED =
  "the sandbox VM is not running, so the engine step was skipped; the next pi starts it and cleans its containers, volumes and images";

export const gcCommand = async (deps: CliDeps, args: string[]) => {
  const sharedOwner = args.includes(SHARED_CACHES) ? userHashOf(pathsOf(deps).stateDir) : undefined;
  const backend = deps.backend();
  const reachable = (await backend.detect()).available;
  const lines = await sweepOrphans(deps, backend, { collect: { sharedOwner } });

  writeLines(deps.stdout, lines);

  if (!reachable) {
    writeLine(deps.stdout, ENGINE_SKIPPED);
  }

  writeLine(deps.stdout, lines.length === 0 ? "nothing to remove" : `done, ${lines.length} removed`);

  return 0;
};
