import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDockerEngineBackend } from "../../backend/docker-engine/backend.ts";
import { createFakeEngine } from "../support/fake-engine.ts";
import { createFakeRunner } from "../support/fake-runner.ts";
import { runBackendConformance } from "./conformance.ts";

const PULLABLE = "example.test/pi-sandbox:1";

runBackendConformance(
  "docker-engine (fake engine)",
  { describe, it, expect, beforeAll, afterAll },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "psh-"));
    const engine = await createFakeEngine({ registry: { [PULLABLE]: `sha256:${"a".repeat(64)}` } });
    const backend = createDockerEngineBackend({
      socketPath: engine.socketPath,
      runner: createFakeRunner(() => undefined).runner,
      home,
    });

    return {
      backend,
      pullableImage: PULLABLE,
      runnableImage: PULLABLE,
      dispose: async () => {
        await engine.close();

        await rm(home, { recursive: true, force: true });
      },
    };
  },
);
