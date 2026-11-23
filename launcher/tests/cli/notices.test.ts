import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeOnce } from "../../cli/notices.ts";
import { sha256Hex, stateLayout } from "../../shared/index.ts";
import { createHarness } from "./harness.ts";

const NOTICE = "pi-sandbox: a notice";

describe("writeOnce", () => {
  it("prints each notice once per install, in one file at the state dir's top level", async () => {
    const harness = await createHarness();

    await writeOnce(harness.deps, harness.stateDir, [NOTICE, NOTICE]);

    await writeOnce(harness.deps, harness.stateDir, [NOTICE, "pi-sandbox: another"]);

    expect(harness.stderr()).toBe(`${NOTICE}\npi-sandbox: another\n`);
    expect(JSON.parse(await readFile(join(harness.stateDir, "seen.json"), "utf8"))).toHaveLength(2);
  });

  it("reads no leftover seen.json of one repository", async () => {
    const harness = await createHarness();
    const leftover = join(
      stateLayout(harness.stateDir).repo(sha256Hex(harness.repoRoot)).directory,
      "seen.json",
    );

    await mkdir(dirname(leftover), { recursive: true });

    await writeFile(leftover, JSON.stringify([sha256Hex(NOTICE).slice(0, 16)]));

    await writeOnce(harness.deps, harness.stateDir, [NOTICE]);

    expect(harness.stderr()).toBe(`${NOTICE}\n`);
  });
});
