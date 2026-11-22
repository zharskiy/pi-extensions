import type { Backend } from "../../backend/index.ts";
import type { SandboxStatusInput } from "../../provision/types.ts";

export { tempDir, writeText } from "../support/temp-dir.ts";

export const runningContainer = async (backend: Backend) => {
  const { id } = await backend.createContainer({
    name: "pi-sandbox-provision",
    image: "pi-sandbox:test",
    labels: {},
    mounts: [],
    network: { kind: "none" },
    env: {},
    workdir: "/",
    readOnlyRoot: false,
    tmpfs: [],
    init: true,
    resources: { pids: 4096 },
    capabilities: ["CHOWN"],
    autoRemove: true,
  });

  await backend.startContainer(id);

  return id;
};

export const NO_STATUS: SandboxStatusInput = {
  resources: { pids: 512 },
  volumes: [],
  binds: [],
  setup: [],
  services: [],
};
