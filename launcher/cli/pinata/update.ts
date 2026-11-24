import { join } from "node:path";
import { LauncherError } from "../../shared/index.ts";
import type { CliDeps } from "../deps.ts";
import { requireJobPi } from "../host-pi.ts";
import { runQuietly, stepsOf } from "../steps.ts";
import { isCheckout, PACKAGE, preflight, refuseBusy } from "./host.ts";

export const update = async (deps: CliDeps, packageDir: string) => {
  if (await isCheckout(deps, packageDir)) {
    throw new LauncherError("this is a checkout: git pull, then pinata install");
  }

  await requireJobPi(deps, "update");

  const steps = stepsOf(deps);

  await preflight(deps, steps);

  await refuseBusy(deps);

  await steps.task(
    { pending: "Updating pinata", done: "Updated pinata", failed: "Could not update pinata" },
    () => runQuietly(deps, ["npm", "install", "-g", "--legacy-peer-deps", `${PACKAGE}@latest`]),
  );

  return deps.runner.spawnInteractive(
    process.execPath,
    [join(packageDir, "launcher", "bin", "pinata.js"), "install", "--yes"],
    { cwd: deps.cwd },
  );
};
