import { stat } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { writeOnce } from "../../cli/notices.ts";
import { stateLayout } from "../../shared/index.ts";
import { createHarness } from "./harness.ts";

describe("writeOnce", () => {
  it("shows a notice once and keeps what it showed readable by the owner only", async () => {
    const harness = await createHarness();
    const scope = { stateDir: harness.stateDir, repoHash: "repo" };

    await writeOnce(harness.deps, scope, ["first notice"]);

    await writeOnce(harness.deps, scope, ["first notice"]);

    expect(harness.stderr()).toBe("pi-sandbox: first notice\n");
    expect((await stat(stateLayout(harness.stateDir).repo("repo").seen)).mode & 0o777).toBe(0o600);
  });
});
