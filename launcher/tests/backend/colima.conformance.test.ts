import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createColimaBackend } from "../../backend/colima/backend.ts";
import { installIdOf } from "../../backend/index.ts";
import { createFakeEngine } from "../support/fake-engine.ts";
import { createFakeRunner } from "../support/fake-runner.ts";
import { runBackendConformance } from "./conformance.ts";

const PULLABLE = "example.test/pi-sandbox:1";

runBackendConformance("colima (fake engine)", { describe, it, expect, beforeAll, afterAll }, async () => {
  const engine = await createFakeEngine({ registry: { [PULLABLE]: `sha256:${"a".repeat(64)}` } });
  const install = installIdOf("/nonexistent");
  const backend = createColimaBackend({
    home: "/nonexistent",
    stateDir: "/nonexistent",
    socketPath: engine.socketPath,
    runner: createFakeRunner(() => undefined).runner,
  });

  return {
    backend,
    install,
    pullableImage: PULLABLE,
    runnableImage: PULLABLE,
    networks: {
      has: async (name) => engine.networks.has(name),
      remove: async (name) => {
        engine.networks.delete(name);
      },
      plantForeign: async (name) => {
        engine.networks.set(name, {
          body: { Name: name, Internal: true, Labels: {} },
          connected: engine.networks.get(name)?.connected ?? [],
        });
      },
    },
    dispose: async () => {
      await engine.close();
    },
  };
});
