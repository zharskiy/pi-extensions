import { join } from "node:path";
import { LauncherError } from "../../shared/index.ts";
import type { CliDeps } from "../deps.ts";
import { interactive, isCheckout, PACKAGE, preflight, refuseBusy } from "./host.ts";
import { refusePinnedManaged } from "./install.ts";

export const update = async (deps: CliDeps, packageDir: string, version?: string, pi?: string) => {
  if (await isCheckout(deps, packageDir)) {
    throw new LauncherError("this is a checkout: git pull, then pinata install");
  }

  await refusePinnedManaged(deps, pi);

  await preflight(deps);

  await refuseBusy(deps);

  await interactive(deps, "npm", [
    "install",
    "-g",
    "--legacy-peer-deps",
    `${PACKAGE}@${version ?? "latest"}`,
  ]);

  const args = ["install", "--yes", ...(pi === undefined ? [] : ["--pi", pi])];

  return deps.runner.spawnInteractive(
    process.execPath,
    [join(packageDir, "launcher", "bin", "pinata.js"), ...args],
    {
      cwd: deps.cwd,
    },
  );
};
