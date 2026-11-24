import { join } from "node:path";
import { LauncherError } from "../../shared/index.ts";
import type { CliDeps } from "../deps.ts";
import { runQuietly, stepsOf } from "../steps.ts";
import { launcherVersion } from "../versions.ts";
import { isCheckout, PACKAGE, preflight, refuseBusy, requireHostPi } from "./host.ts";
import { UPDATED_FROM } from "./install.ts";

export const update = async (deps: CliDeps, packageDir: string, version?: string) => {
  if (await isCheckout(deps, packageDir)) {
    throw new LauncherError("this is a checkout: git pull, then pinata install");
  }

  await requireHostPi(deps, "update");

  const steps = stepsOf(deps);

  await preflight(deps, steps);

  await refuseBusy(deps);

  const from = await launcherVersion();
  const spec = `${PACKAGE}@${version ?? "latest"}`;

  await steps.task({ pending: "Updating pinata", failed: "Could not update pinata" }, () =>
    runQuietly(deps, ["npm", "install", "-g", "--legacy-peer-deps", spec]),
  );

  return deps.runner.spawnInteractive(
    process.execPath,
    [join(packageDir, "launcher", "bin", "pinata.js"), "install", "--yes"],
    {
      cwd: deps.cwd,
      env: { [UPDATED_FROM]: from },
    },
  );
};
