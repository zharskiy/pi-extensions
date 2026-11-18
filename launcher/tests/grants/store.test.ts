import { stat } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { activeGrants, addGrant, readGrants, revokeGrants } from "../../grants/store.ts";
import { FAKE_EPOCH } from "../support/fake-clock.ts";
import { tempDir } from "../support/temp-dir.ts";

const REPO = "1".repeat(64);

const OTHER = "2".repeat(64);

const state = { stateDir: "" };

beforeEach(async () => {
  state.stateDir = await tempDir("grants");
});

describe("addGrant and readGrants", () => {
  it("stores grants in a private file, replacing the same target", async () => {
    await addGrant(state.stateDir, { host: "API.test", port: 443, repoHash: REPO }, FAKE_EPOCH);

    await addGrant(state.stateDir, { host: "api.test", port: 443, repoHash: REPO }, FAKE_EPOCH + 1);

    expect(await readGrants(state.stateDir)).toEqual([
      { host: "api.test", port: 443, repoHash: REPO, createdAt: FAKE_EPOCH + 1 },
    ]);
    expect((await stat(join(state.stateDir, "grants.json"))).mode & 0o777).toBe(0o600);
  });

  it("keeps a user-wide grant apart from the grant of one repository", async () => {
    await addGrant(state.stateDir, { host: "a.test", port: 443, repoHash: REPO }, FAKE_EPOCH);

    await addGrant(state.stateDir, { host: "a.test", port: 443 }, FAKE_EPOCH);

    expect(await readGrants(state.stateDir)).toEqual([
      { host: "a.test", port: 443, repoHash: REPO, createdAt: FAKE_EPOCH },
      { host: "a.test", port: 443, createdAt: FAKE_EPOCH },
    ]);
  });
});

describe("revokeGrants", () => {
  it("removes the grants of one scope, every port unless one is named", async () => {
    await addGrant(state.stateDir, { host: "a.test", port: 443, repoHash: REPO }, FAKE_EPOCH);

    await addGrant(state.stateDir, { host: "a.test", port: 8443, repoHash: REPO }, FAKE_EPOCH);

    await addGrant(state.stateDir, { host: "a.test", port: 443 }, FAKE_EPOCH);

    expect(await revokeGrants(state.stateDir, { host: "a.test", repoHash: REPO })).toBe(2);
    expect(await readGrants(state.stateDir)).toEqual([{ host: "a.test", port: 443, createdAt: FAKE_EPOCH }]);
    expect(await revokeGrants(state.stateDir, { host: "a.test", port: 443 })).toBe(1);
  });
});

describe("activeGrants", () => {
  it("applies the grants of the repository and the user-wide grants", () => {
    const grants = [
      { host: "mine.test", port: 443, repoHash: REPO, createdAt: 0 },
      { host: "other.test", port: 443, repoHash: OTHER, createdAt: 0 },
      { host: "everywhere.test", port: 443, createdAt: 0 },
    ];

    expect(activeGrants(grants, REPO).map((grant) => grant.host)).toEqual(["mine.test", "everywhere.test"]);
  });
});
