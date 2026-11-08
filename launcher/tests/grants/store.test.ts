import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activeGrants, addGrant, readGrants, revokeGrants } from "../../grants/store.ts";
import { LauncherError } from "../../shared/index.ts";
import { FAKE_EPOCH } from "../support/fake-clock.ts";

const REPO = "1".repeat(64);

const OTHER = "2".repeat(64);

const state = { stateDir: "" };

beforeEach(async () => {
  state.stateDir = await mkdtemp(join(tmpdir(), "pi-sandbox-grants-"));
});

afterEach(async () => {
  await rm(state.stateDir, { recursive: true, force: true });
});

describe("addGrant and readGrants", () => {
  it("stores grants in a private file, replacing the same target", async () => {
    await addGrant(state.stateDir, { host: "API.test", port: 443, repoHash: REPO }, true, FAKE_EPOCH);

    await addGrant(state.stateDir, { host: "api.test", port: 443, repoHash: REPO }, true, FAKE_EPOCH + 1);

    expect(await readGrants(state.stateDir)).toEqual([
      { host: "api.test", port: 443, repoHash: REPO, createdAt: FAKE_EPOCH + 1 },
    ]);
    expect((await stat(join(state.stateDir, "grants.json"))).mode & 0o777).toBe(0o600);
  });

  it("keeps a user-wide grant apart from the grant of one repository", async () => {
    await addGrant(state.stateDir, { host: "a.test", port: 443, repoHash: REPO }, true, FAKE_EPOCH);

    await addGrant(state.stateDir, { host: "a.test", port: 443 }, true, FAKE_EPOCH);

    expect(await readGrants(state.stateDir)).toEqual([
      { host: "a.test", port: 443, repoHash: REPO, createdAt: FAKE_EPOCH },
      { host: "a.test", port: 443, createdAt: FAKE_EPOCH },
    ]);
  });

  it("refuses a grant when grants are off and writes nothing", async () => {
    await expect(addGrant(state.stateDir, { host: "a.test", port: 443 }, false, FAKE_EPOCH)).rejects.toThrow(
      new LauncherError("egress grants are turned off by egress.grants"),
    );
    expect(await readGrants(state.stateDir)).toEqual([]);
  });
});

describe("revokeGrants", () => {
  it("removes the grants of one scope, every port unless one is named", async () => {
    await addGrant(state.stateDir, { host: "a.test", port: 443, repoHash: REPO }, true, FAKE_EPOCH);

    await addGrant(state.stateDir, { host: "a.test", port: 8443, repoHash: REPO }, true, FAKE_EPOCH);

    await addGrant(state.stateDir, { host: "a.test", port: 443 }, true, FAKE_EPOCH);

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
