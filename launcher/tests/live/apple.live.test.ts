import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAppleBackend } from "../../backend/index.ts";
import { createProcessRunner } from "../../shared/index.ts";
import { runBackendConformance } from "../backend/conformance.ts";

const CONTAINER_CLI = "container";

const PULLABLE = "docker.io/library/busybox:1.36";

const RUNNABLE = "pi-sandbox-conformance:busybox";

const installed = (process.env.PATH ?? "")
  .split(delimiter)
  .some((dir) => dir !== "" && existsSync(join(dir, CONTAINER_CLI)));

const enabled = process.env.PI_SANDBOX_LIVE === "1" && process.platform === "darwin" && installed;

const hooks = enabled
  ? { describe, it, expect, beforeAll, afterAll }
  : { describe: describe.skip, it, expect, beforeAll, afterAll };

runBackendConformance(
  "apple (container CLI)",
  hooks,
  async () => {
    const runner = createProcessRunner();
    const backend = createAppleBackend({ runner });
    const context = await mkdtemp(join(tmpdir(), "pi-sandbox-live-"));

    await backend.pullImage(PULLABLE);

    await writeFile(join(context, "Dockerfile"), `FROM ${PULLABLE}\nCMD ["sleep", "3600"]\n`);

    await backend.buildImage(context, RUNNABLE);

    await rm(context, { recursive: true, force: true });

    return {
      backend,
      pullableImage: PULLABLE,
      runnableImage: RUNNABLE,
      networks: {
        has: async (name) => {
          const inspected = await runner.run(CONTAINER_CLI, ["network", "inspect", name]);

          return inspected.code === 0 && inspected.stdout.includes(name);
        },
        remove: async (name) => {
          await runner.run(CONTAINER_CLI, ["network", "delete", name]);
        },
      },
    };
  },
  { sharedRuntime: true },
);
