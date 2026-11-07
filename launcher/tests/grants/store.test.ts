import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  activeGrants,
  addGrant,
  pruneGrants,
  readGrants,
  revokeGrants,
  SESSION_GRANT_CAP_HOURS,
} from "../../grants/store.ts";
import { LauncherError } from "../../shared/index.ts";
import { FAKE_EPOCH } from "../support/fake-clock.ts";

const HOUR = 3_600_000;

const LIMITS = { enabled: true, maxHours: 168, permanent: true };

const REPO = "1".repeat(64);

const OTHER = "2".repeat(64);

const state = { stateDir: "" };

beforeEach(async () => {
  state.stateDir = await mkdtemp(join(tmpdir(), "pi-sandbox-grants-"));
});

afterEach(async () => {
  await rm(state.stateDir, { recursive: true, force: true });
});

const context = (overrides: { now?: number; repoHash?: string; live?: string[] } = {}) => ({
  now: overrides.now ?? FAKE_EPOCH,
  repoHash: overrides.repoHash ?? REPO,
  liveLaunches: new Set(overrides.live ?? []),
});

describe("addGrant and readGrants", () => {
  it("stores grants in a private file, replacing the same target", async () => {
    await addGrant(
      state.stateDir,
      { host: "API.test", port: 443, repoHash: REPO, scope: { kind: "hours", hours: 2 } },
      LIMITS,
      FAKE_EPOCH,
    );

    await addGrant(
      state.stateDir,
      { host: "api.test", port: 443, repoHash: REPO, scope: { kind: "permanent" } },
      LIMITS,
      FAKE_EPOCH,
    );

    expect(await readGrants(state.stateDir)).toEqual([
      { host: "api.test", port: 443, repoHash: REPO, createdAt: FAKE_EPOCH },
    ]);
    expect((await stat(join(state.stateDir, "grants.json"))).mode & 0o777).toBe(0o600);
  });

  it("gives a session grant its launch and the 12 hour cap", async () => {
    const grant = await addGrant(
      state.stateDir,
      { host: "a.test", port: 443, scope: { kind: "session", launchId: "0123456789abcdef" } },
      LIMITS,
      FAKE_EPOCH,
    );

    expect(grant).toEqual({
      host: "a.test",
      port: 443,
      createdAt: FAKE_EPOCH,
      launchId: "0123456789abcdef",
      expiresAt: FAKE_EPOCH + SESSION_GRANT_CAP_HOURS * HOUR,
    });
  });

  it("ends a session grant at egress.grants.maxHours when that is under 12 hours", async () => {
    const grant = await addGrant(
      state.stateDir,
      { host: "a.test", port: 443, scope: { kind: "session", launchId: "0123456789abcdef" } },
      { ...LIMITS, maxHours: 2 },
      FAKE_EPOCH,
    );

    expect(grant.expiresAt).toBe(FAKE_EPOCH + 2 * HOUR);
  });

  it.each([
    [{ ...LIMITS, enabled: false }, { kind: "session", launchId: "0123456789abcdef" } as const],
    [{ ...LIMITS, permanent: false }, { kind: "permanent" } as const],
    [{ ...LIMITS, maxHours: 4 }, { kind: "hours", hours: 5 } as const],
    [LIMITS, { kind: "hours", hours: 0 } as const],
  ])("refuses a grant outside the limits %#", async (limits, scope) => {
    await expect(
      addGrant(state.stateDir, { host: "a.test", port: 443, scope }, limits, FAKE_EPOCH),
    ).rejects.toBeInstanceOf(LauncherError);
    expect(await readGrants(state.stateDir)).toEqual([]);
  });
});

describe("revokeGrants", () => {
  it("removes matching grants of one scope and counts them", async () => {
    await addGrant(
      state.stateDir,
      { host: "a.test", port: 443, repoHash: REPO, scope: { kind: "permanent" } },
      LIMITS,
      FAKE_EPOCH,
    );

    await addGrant(
      state.stateDir,
      { host: "a.test", port: 8443, repoHash: REPO, scope: { kind: "permanent" } },
      LIMITS,
      FAKE_EPOCH,
    );

    await addGrant(
      state.stateDir,
      { host: "a.test", port: 443, scope: { kind: "permanent" } },
      LIMITS,
      FAKE_EPOCH,
    );

    expect(await revokeGrants(state.stateDir, { host: "a.test", repoHash: REPO })).toBe(2);
    expect(await readGrants(state.stateDir)).toEqual([{ host: "a.test", port: 443, createdAt: FAKE_EPOCH }]);
    expect(await revokeGrants(state.stateDir, { host: "a.test", port: 443 })).toBe(1);
  });
});

describe("activeGrants", () => {
  const grants = [
    { host: "user.test", port: 443, createdAt: 0 },
    { host: "repo.test", port: 443, repoHash: REPO, createdAt: 0 },
    { host: "other.test", port: 443, repoHash: OTHER, createdAt: 0 },
    { host: "hours.test", port: 443, createdAt: 0, expiresAt: FAKE_EPOCH + HOUR },
    { host: "session.test", port: 443, createdAt: 0, expiresAt: FAKE_EPOCH + HOUR, launchId: "live" },
  ];

  const hosts = (found: Array<{ host: string }>) => found.map((grant) => grant.host);

  it("keeps user and own-repository grants that have not expired, sessions only while live", () => {
    expect(hosts(activeGrants(grants, context({ live: ["live"] })))).toEqual([
      "user.test",
      "repo.test",
      "hours.test",
      "session.test",
    ]);
    expect(hosts(activeGrants(grants, context()))).not.toContain("session.test");
    expect(hosts(activeGrants(grants, context({ now: FAKE_EPOCH + HOUR, live: ["live"] })))).toEqual([
      "user.test",
      "repo.test",
    ]);
  });
});

describe("pruneGrants", () => {
  it("drops expired grants and session grants of ended launches", async () => {
    await addGrant(
      state.stateDir,
      { host: "keep.test", port: 443, scope: { kind: "permanent" } },
      LIMITS,
      FAKE_EPOCH,
    );

    await addGrant(
      state.stateDir,
      { host: "hours.test", port: 443, scope: { kind: "hours", hours: 1 } },
      LIMITS,
      FAKE_EPOCH,
    );

    await addGrant(
      state.stateDir,
      { host: "ended.test", port: 443, scope: { kind: "session", launchId: "0123456789abcdef" } },
      LIMITS,
      FAKE_EPOCH,
    );

    expect(await pruneGrants(state.stateDir, { now: FAKE_EPOCH + 2 * HOUR, liveLaunches: new Set() })).toBe(
      2,
    );
    expect((await readGrants(state.stateDir)).map((grant) => grant.host)).toEqual(["keep.test"]);
  });
});
