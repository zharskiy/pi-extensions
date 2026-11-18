import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../../cli/index.ts";
import { createFakeBackend, createHarness } from "./harness.ts";

describe("the git layout check at launch", () => {
  it("refuses a repository whose commondir git did not write, naming the file, and starts nothing", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });
    const commondir = join(harness.repoRoot, ".git", "commondir");

    await writeFile(commondir, "../.x\n");

    expect(await run([], harness.deps)).toBe(1);
    expect(harness.stderr()).toContain(`pi-sandbox: git: ${commondir} was not written by git`);
    expect(fake.created).toHaveLength(0);
    expect(harness.calls.some((call) => call.file === "git")).toBe(false);
  });
});
