import { type ContainerSummary, ENGINE_PROFILE, LABELS } from "../../backend/index.ts";
import { repoRecordOf } from "../../shared/index.ts";
import { type CliDeps, pathsOf, writeLines } from "../deps.ts";

const sessionLine = async (stateDir: string, container: ContainerSummary) => {
  const hash = container.labels[LABELS.repoHash];
  const record = hash === undefined ? undefined : await repoRecordOf(stateDir, hash);

  return `session: ${record?.root ?? "unknown"} ${container.id.slice(0, 12)} ${container.state}`;
};

export const listCommand = async (deps: CliDeps) => {
  const backend = deps.backend();
  const vm = await backend.vm.inspect().catch(() => ({ state: "stopped" as const, size: undefined }));
  const size =
    vm.state === "absent" || vm.size === undefined
      ? ""
      : ` (${vm.size.cpus} cpus, ${vm.size.memoryGiB} GiB memory)`;

  if (vm.state !== "running") {
    writeLines(deps.stdout, [
      `vm: ${ENGINE_PROFILE} ${vm.state === "absent" ? "not created" : "stopped"}${size}`,
    ]);

    return 0;
  }

  const sessions = await backend.findContainers({ [LABELS.role]: "agent" });
  const lines = await Promise.all(sessions.map((session) => sessionLine(pathsOf(deps).stateDir, session)));

  writeLines(deps.stdout, [`vm: ${ENGINE_PROFILE} running${size}`, ...lines]);

  return 0;
};
