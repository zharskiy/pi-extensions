import { shareText } from "../../backend/index.ts";
import { loadEffectiveConfig } from "../../config/index.ts";
import { type CliDeps, writeLine, writeLines, writeNotices } from "../deps.ts";
import { prepareVmShares } from "../vm.ts";

export const VM_SHARES = "__vm-shares";

export const vmSharesCommand = async (deps: CliDeps) => {
  const { config } = await loadEffectiveConfig({ env: deps.env, home: deps.home });
  const plan = await prepareVmShares(deps, config.workspaceRoots);

  if (plan === undefined) {
    writeLine(deps.stdout, `${deps.home}:w`);

    return 0;
  }

  writeNotices(deps, plan.notices);

  writeLines(deps.stdout, plan.shares.map(shareText));

  return 0;
};
