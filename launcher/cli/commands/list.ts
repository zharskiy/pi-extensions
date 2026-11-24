import { type ContainerSummary, LABELS, type VmSpec } from "../../backend/index.ts";
import { repoRecordOf } from "../../shared/index.ts";
import { type CliDeps, pathsOf } from "../deps.ts";
import { stepsOf, tilde } from "../steps.ts";

const sessionText = async (deps: CliDeps, container: ContainerSummary) => {
  const hash = container.labels[LABELS.repoHash];
  const record = hash === undefined ? undefined : await repoRecordOf(pathsOf(deps).stateDir, hash);
  const folder = record === undefined ? "a folder pinata no longer knows" : tilde(deps, record.root);

  return `${folder} (${container.id.slice(0, 12)}, ${container.state})`;
};

const sizeText = (size: VmSpec | undefined) =>
  size === undefined ? "" : ` with ${size.cpus} CPUs and ${size.memoryGiB} GiB of memory`;

export const listCommand = async (deps: CliDeps) => {
  const steps = stepsOf(deps);
  const backend = deps.backend();
  const vm = await backend.vm.inspect().catch(() => ({ state: "stopped" as const, size: undefined }));

  if (vm.state === "absent") {
    steps.close("The sandbox VM is not created yet.");

    return 0;
  }

  if (vm.state !== "running") {
    steps.close(`The sandbox VM is stopped${sizeText(vm.size)}.`);

    return 0;
  }

  const containers = await backend.findContainers({ [LABELS.role]: "agent" });
  const sessions = await Promise.all(containers.map((container) => sessionText(deps, container)));
  const rows = sessions.map((session, index): [string, string] => [index === 0 ? "Sessions" : "", session]);

  steps.close(
    `The sandbox VM is running${sizeText(vm.size)}.`,
    rows.length === 0 ? [["Sessions", "none"]] : rows,
  );

  return 0;
};
