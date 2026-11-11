import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createColimaBackend } from "../../backend/colima/backend.ts";
import { LABELS } from "../../backend/index.ts";
import { createFakeEngine } from "../support/fake-engine.ts";
import { createFakeRunner } from "../support/fake-runner.ts";
import { runBackendConformance } from "./conformance.ts";

const PULLABLE = "example.test/pi-sandbox:1";

runBackendConformance("colima (fake engine)", { describe, it, expect, beforeAll, afterAll }, async () => {
  const engine = await createFakeEngine({ registry: { [PULLABLE]: `sha256:${"a".repeat(64)}` } });
  const backend = createColimaBackend({
    home: "/nonexistent",
    stateDir: "/nonexistent",
    socketPath: engine.socketPath,
    runner: createFakeRunner(() => undefined).runner,
  });

  return {
    backend,
    pullableImage: PULLABLE,
    runnableImage: PULLABLE,
    networks: {
      has: async (name) => engine.networks.has(name),
      remove: async (name) => {
        engine.networks.delete(name);
      },
      plant: async (name, traits) => {
        engine.networks.set(name, {
          body: {
            Name: name,
            Internal: traits.internal,
            Labels: traits.managed ? { [LABELS.managed]: "true" } : {},
          },
          connected: [],
        });
      },
    },
    dispose: async () => {
      await engine.close();
    },
  };
});
