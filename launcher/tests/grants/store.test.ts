import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { addGrant, readGrants, revokeGrants } from "../../grants/store.ts";
import { FAKE_EPOCH } from "../support/fake-clock.ts";
import { tempDir } from "../support/temp-dir.ts";

const state = { stateDir: "" };

beforeEach(async () => {
  state.stateDir = await tempDir("grants");
});

describe("addGrant and readGrants", () => {
  it("stores grants in a private file, replacing the same target", async () => {
    await addGrant(state.stateDir, { host: "API.test", port: 443 }, FAKE_EPOCH);

    await addGrant(state.stateDir, { host: "api.test", port: 443 }, FAKE_EPOCH + 1);

    expect(await readGrants(state.stateDir)).toEqual([
      { host: "api.test", port: 443, createdAt: FAKE_EPOCH + 1 },
    ]);
    expect((await stat(join(state.stateDir, "grants.json"))).mode & 0o777).toBe(0o600);
  });

  it("ignores a stored grant of one repository and drops it at the next write, never widening it", async () => {
    const file = join(state.stateDir, "grants.json");

    await writeFile(
      file,
      JSON.stringify([
        { host: "old.test", port: 443, repoHash: "1".repeat(64), createdAt: 1 },
        { host: "kept.test", port: 443, createdAt: 1 },
      ]),
    );

    expect(await readGrants(state.stateDir)).toEqual([{ host: "kept.test", port: 443, createdAt: 1 }]);

    await addGrant(state.stateDir, { host: "new.test", port: 443 }, FAKE_EPOCH);

    expect(JSON.parse(await readFile(file, "utf8"))).toEqual([
      { host: "kept.test", port: 443, createdAt: 1 },
      { host: "new.test", port: 443, createdAt: FAKE_EPOCH },
    ]);
  });
});

describe("revokeGrants", () => {
  it("removes the grants of a host, every port unless one is named", async () => {
    await addGrant(state.stateDir, { host: "a.test", port: 443 }, FAKE_EPOCH);

    await addGrant(state.stateDir, { host: "a.test", port: 8443 }, FAKE_EPOCH);

    await addGrant(state.stateDir, { host: "b.test", port: 443 }, FAKE_EPOCH);

    expect(await revokeGrants(state.stateDir, { host: "a.test", port: 8443 })).toBe(1);
    expect(await revokeGrants(state.stateDir, { host: "a.test" })).toBe(1);
    expect(await readGrants(state.stateDir)).toEqual([{ host: "b.test", port: 443, createdAt: FAKE_EPOCH }]);
  });
});
