import { join } from "node:path";
import { LauncherError } from "../../shared/index.ts";
import type { CliDeps } from "../deps.ts";
import { interactive, isCheckout, PACKAGE, preflight, refuseBusy, requireHostPi } from "./host.ts";

export const update = async (deps: CliDeps, packageDir: string, version?: string) => {
  if (await isCheckout(deps, packageDir)) {
    throw new LauncherError("this is a checkout: git pull, then pinata install");
  }

  await requireHostPi(deps, "update");

  await preflight(deps);

  await refuseBusy(deps);

  await interactive(deps, "npm", [
    "install",
    "-g",
    "--legacy-peer-deps",
    `${PACKAGE}@${version ?? "latest"}`,
  ]);

  return deps.runner.spawnInteractive(
    process.execPath,
    [join(packageDir, "launcher", "bin", "pinata.js"), "install", "--yes"],
    {
      cwd: deps.cwd,
    },
  );
};
