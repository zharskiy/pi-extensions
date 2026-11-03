import { collectGarbage } from "../../container/index.ts";
import { type CliDeps, writeLine, writeLines } from "../deps.ts";
import { openBackend, openContext } from "../launch.ts";

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

export const gcCommand = async (deps: CliDeps) => {
  const { effective, stateDir } = await openContext(deps);
  const backend = await openBackend(deps, effective.config);
  const garbage = await collectGarbage(backend);
  const idle = (await deps.proxy.list(stateDir)).filter(
    (instance) => !garbage.policyHashesInUse.includes(instance.policyHash),
  );

  await Promise.all(idle.map((instance) => deps.proxy.stop(stateDir, instance.policyHash)));

  writeLines(deps.stdout, [
    ...garbage.containers.map((container) => `removed ${container.name} (${container.id})`),
    ...garbage.relays.map((relay) => `removed relay ${relay.name} (${relay.id})`),
    ...idle.map((instance) => `stopped proxy pid ${instance.pid} port ${instance.port}`),
  ]);

  writeLine(deps.stdout, `removed ${plural(garbage.containers.length, "stopped container")}`);

  return 0;
};
