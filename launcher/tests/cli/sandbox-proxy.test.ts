import { describe, expect, it } from "vitest";
import { run } from "../../cli/index.ts";
import { createFakeBackend } from "../support/fake-backend.ts";
import { createHarness } from "./harness.ts";

describe("env-sourced credentials", () => {
  it("refuses a secret value with a line break before the sandbox starts", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({
      adapters: () => [fake.backend],
      env: { CORP_TOKEN: "abc\r\nX-Evil: 1" },
    });

    await harness.writeJson(harness.userConfigFile, {
      credentials: {
        rules: [
          {
            id: "corp",
            host: "corp.example.test",
            placeholder: "pi-sandbox-corp",
            secret: { env: "CORP_TOKEN" },
          },
        ],
      },
    });

    expect(await run([], harness.deps)).toBe(1);
    expect(harness.stderr()).toContain(
      "pi-sandbox: CORP_TOKEN contains a line break and cannot be used as a credential",
    );
    expect(harness.controlMessages).toEqual([]);
    expect(fake.containers.size).toBe(0);
  });
});
