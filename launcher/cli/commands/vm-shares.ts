import { loadEffectiveConfig } from "../../config/index.ts";
import { hostBinds, sharedRootsOf } from "../../workspace/index.ts";
import { type CliDeps, writeLine, writeLines, writeNotices } from "../deps.ts";
import { prepareVmShares } from "../vm.ts";

export const VM_SHARES = "__vm-shares";

export const vmSharesCommand = async (deps: CliDeps) => {
  const { workspaceRoots, mounts } = (await loadEffectiveConfig({ env: deps.env, home: deps.home })).config;

  if (workspaceRoots === undefined) {
    writeLine(deps.stdout, deps.home);

    return 0;
  }

  const context = { home: deps.home, env: deps.env };
  const binds = hostBinds(mounts.binds, { ...context, roots: workspaceRoots.roots });
  const plan = await prepareVmShares(deps, workspaceRoots, binds);

  writeNotices(deps, plan?.notices ?? []);

  writeLines(deps.stdout, sharedRootsOf(workspaceRoots, context).roots);

  return 0;
};
