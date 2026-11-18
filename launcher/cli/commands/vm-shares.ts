import { loadEffectiveConfig } from "../../config/index.ts";
import { sharedRootsOf } from "../../workspace/index.ts";
import { type CliDeps, writeLine, writeLines, writeNotices } from "../deps.ts";
import { prepareVmShares } from "../vm.ts";

export const VM_SHARES = "__vm-shares";

export const vmSharesCommand = async (deps: CliDeps) => {
  const { workspaceRoots } = (await loadEffectiveConfig({ env: deps.env, home: deps.home })).config;

  if (workspaceRoots === undefined) {
    writeLine(deps.stdout, deps.home);

    return 0;
  }

  const plan = await prepareVmShares(deps, workspaceRoots);

  writeNotices(deps, plan?.notices ?? []);

  writeLines(deps.stdout, sharedRootsOf(workspaceRoots, { home: deps.home, env: deps.env }).roots);

  return 0;
};
