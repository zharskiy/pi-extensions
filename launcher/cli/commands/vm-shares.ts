import { loadEffectiveConfig } from "../../config/index.ts";
import { hostBinds } from "../../workspace/index.ts";
import { type CliDeps, writeLines, writeNotices } from "../deps.ts";
import { prepareVmShares, rootPaths } from "../vm.ts";

export const VM_SHARES = "__vm-shares";

export const vmSharesCommand = async (deps: CliDeps) => {
  const { config } = await loadEffectiveConfig({ env: deps.env, home: deps.home });
  const binds = hostBinds(config.mounts.binds, { home: deps.home, env: deps.env, roots: rootPaths(config) });
  const plan = await prepareVmShares(deps, config.workspaceRoot, binds);

  writeNotices(deps, plan.notices);

  writeLines(deps.stdout, plan.root === undefined ? [] : [plan.root]);

  return 0;
};
