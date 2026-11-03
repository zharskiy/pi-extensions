import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAppleBackend } from "../../backend/apple/backend.ts";
import { createFakeContainerCli } from "../support/fake-container-cli.ts";
import { runBackendConformance } from "./conformance.ts";

const PULLABLE = "example.test/pi-sandbox:1";

runBackendConformance(
  "apple (fake container CLI)",
  { describe, it, expect, beforeAll, afterAll },
  async () => {
    const cli = createFakeContainerCli({ registry: { [PULLABLE]: `sha256:${"b".repeat(64)}` } });

    return {
      backend: createAppleBackend({ runner: cli.runner, spawn: cli.spawn }),
      pullableImage: PULLABLE,
      runnableImage: PULLABLE,
    };
  },
);
