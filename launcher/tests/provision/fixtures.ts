import type { Backend } from "../../backend/index.ts";

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
    resources: {},
  });

  await backend.startContainer(id);

  return id;
};
