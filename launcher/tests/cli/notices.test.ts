import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeOnce } from "../../cli/notices.ts";
import { createHarness } from "./harness.ts";

const NOTICE = "pinata: a notice";

describe("writeOnce", () => {
  it("prints each notice once per install, in one file at the state dir's top level", async () => {
    const harness = await createHarness();

    await writeOnce(harness.deps, harness.stateDir, [NOTICE, NOTICE]);

    await writeOnce(harness.deps, harness.stateDir, [NOTICE, "pinata: another"]);

    expect(harness.stderr()).toBe(`${NOTICE}\npinata: another\n`);
    expect(JSON.parse(await readFile(join(harness.stateDir, "seen.json"), "utf8"))).toHaveLength(2);
  });
});
