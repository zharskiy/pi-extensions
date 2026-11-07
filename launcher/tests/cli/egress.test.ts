import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../../cli/index.ts";
import { readGrants, registerSession } from "../../grants/index.ts";
import { sha256Hex } from "../../shared/index.ts";
import { createHarness } from "./harness.ts";

const harnesses: Array<{ cleanup(): Promise<void> }> = [];

const harnessWith = async (options: Parameters<typeof createHarness>[0] = {}) => {
  const harness = await createHarness(options);

  harnesses.push(harness);

  return harness;
};

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.cleanup()));
});

const NOW = 1_700_000_000_000;

const HOUR = 3_600_000;

const LAUNCH = "0123456789abcdef";

const liveSession = (harness: { stateDir: string; repoRoot: string }, launchId = LAUNCH, startedAt = 1) =>
  registerSession(harness.stateDir, {
    launchId,
    pid: process.pid,
    repoHash: sha256Hex(harness.repoRoot),
    startedAt,
  });

describe("pi sandbox egress allow", () => {
  it("grants a host for N hours to this repository", async () => {
    const harness = await harnessWith();

    expect(await run(["sandbox", "egress", "allow", "Docs.Example.test", "--hours", "2"], harness.deps)).toBe(
      0,
    );
    expect(await readGrants(harness.stateDir)).toEqual([
      {
        host: "docs.example.test",
        port: 443,
        repoHash: sha256Hex(harness.repoRoot),
        createdAt: NOW,
        expiresAt: NOW + 2 * HOUR,
      },
    ]);
    expect(harness.stdout()).toBe(
      `allowed docs.example.test for this repository until ${new Date(NOW + 2 * HOUR).toISOString()}\n`,
    );
  });

  it("grants a host:port permanently to every repository with --user", async () => {
    const harness = await harnessWith();

    expect(
      await run(
        ["sandbox", "egress", "allow", "git.example.test:8443", "--permanent", "--user"],
        harness.deps,
      ),
    ).toBe(0);
    expect(await readGrants(harness.stateDir)).toEqual([
      { host: "git.example.test", port: 8443, createdAt: NOW },
    ]);
    expect(harness.stdout()).toBe("allowed git.example.test:8443 for every repository permanently\n");
  });

  it("outside a sandbox session, grants the host to every live pi session of the repository and says so", async () => {
    const harness = await harnessWith();

    await liveSession(harness, "1111111111111111", 1);

    await liveSession(harness, LAUNCH, 2);

    expect(await run(["sandbox", "egress", "allow", "docs.example.test"], harness.deps)).toBe(0);

    const grants = await readGrants(harness.stateDir);

    expect(grants.map((grant) => grant.launchId).sort()).toEqual([LAUNCH, "1111111111111111"]);
    expect(grants.every((grant) => grant.expiresAt === NOW + 12 * HOUR)).toBe(true);
    expect(harness.stdout()).toContain(
      "the grant applies to each of the 2 running pi sessions of this repository",
    );
  });

  it("refuses a host outside the policy allowlist, naming the layer, and stores nothing", async () => {
    const harness = await harnessWith();

    await harness.writeJson(harness.policyFile, { egress: { allow: ["*.example.test"] } });

    expect(await run(["sandbox", "egress", "allow", "evil.test", "--hours", "1"], harness.deps)).toBe(1);
    expect(harness.stderr()).toContain(
      "pi-sandbox: evil.test is outside the allowlist set by policy; grants cannot add it",
    );
    expect(await run(["sandbox", "egress", "allow", "docs.example.test", "--hours", "1"], harness.deps)).toBe(
      0,
    );
    expect((await readGrants(harness.stateDir)).map((grant) => grant.host)).toEqual(["docs.example.test"]);
  });

  it("lets a policy that opts into grants keep its allowlist from capping them", async () => {
    const harness = await harnessWith();

    await harness.writeJson(harness.policyFile, {
      egress: { allow: ["*.example.test"], grants: { enabled: true } },
    });

    expect(await run(["sandbox", "egress", "allow", "other.test", "--hours", "1"], harness.deps)).toBe(0);
  });

  it("keys the session grant to PI_SANDBOX_LAUNCH_ID when set", async () => {
    const harness = await harnessWith({ env: { PI_SANDBOX_LAUNCH_ID: "1111111111111111" } });

    await liveSession(harness, "1111111111111111", 1);

    await liveSession(harness, LAUNCH, 2);

    expect(await run(["sandbox", "egress", "allow", "docs.example.test", "--session"], harness.deps)).toBe(0);
    expect((await readGrants(harness.stateDir))[0]?.launchId).toBe("1111111111111111");
  });

  it("refuses a session grant when no pi session runs for the repository", async () => {
    const harness = await harnessWith();

    expect(await run(["sandbox", "egress", "allow", "docs.example.test"], harness.deps)).toBe(1);
    expect(harness.stderr()).toContain("no pi session is running for this repository");
    expect(await readGrants(harness.stateDir)).toEqual([]);
  });

  it("applies the limits from egress.grants", async () => {
    const harness = await harnessWith();

    await harness.writeJson(harness.policyFile, { egress: { grants: { maxHours: 4, permanent: false } } });

    expect(await run(["sandbox", "egress", "allow", "docs.example.test", "--hours", "5"], harness.deps)).toBe(
      1,
    );
    expect(harness.stderr()).toContain("--hours 5 exceeds egress.grants.maxHours (4)");
    expect(await run(["sandbox", "egress", "allow", "docs.example.test", "--permanent"], harness.deps)).toBe(
      1,
    );
    expect(harness.stderr()).toContain("permanent egress grants are turned off by egress.grants.permanent");
    expect(await readGrants(harness.stateDir)).toEqual([]);
  });

  it("refuses a target that is not a host name and conflicting scopes", async () => {
    const harness = await harnessWith();

    expect(await run(["sandbox", "egress", "allow", "*.example.test"], harness.deps)).toBe(1);
    expect(harness.stderr()).toContain("egress: *.example.test is not a host or host:port");
    expect(
      await run(["sandbox", "egress", "allow", "a.test", "--hours", "1", "--permanent"], harness.deps),
    ).toBe(1);
    expect(harness.stderr()).toContain("pick one of --session, --hours N and --permanent");
  });
});

describe("pi sandbox egress revoke and list", () => {
  it("revokes this repository's grants for a host, and user grants with --user", async () => {
    const harness = await harnessWith();

    await run(["sandbox", "egress", "allow", "docs.example.test", "--hours", "1"], harness.deps);

    await run(["sandbox", "egress", "allow", "docs.example.test", "--hours", "1", "--user"], harness.deps);

    expect(await run(["sandbox", "egress", "revoke", "docs.example.test"], harness.deps)).toBe(0);
    expect(harness.stdout()).toContain("revoked 1 grant for docs.example.test\n");
    expect(await readGrants(harness.stateDir)).toEqual([
      expect.not.objectContaining({ repoHash: expect.anything() }),
    ]);

    expect(await run(["sandbox", "egress", "revoke", "docs.example.test", "--user"], harness.deps)).toBe(0);
    expect(await readGrants(harness.stateDir)).toEqual([]);
  });

  it("lists active grants and hides ended or foreign ones", async () => {
    const harness = await harnessWith();

    await writeFile(
      join(harness.stateDir, "grants.json"),
      JSON.stringify([
        { host: "live.example.test", port: 443, repoHash: sha256Hex(harness.repoRoot), createdAt: 1 },
        { host: "user.example.test", port: 8443, createdAt: 1, expiresAt: NOW + HOUR },
        { host: "expired.example.test", port: 443, createdAt: 1, expiresAt: NOW - 1 },
        {
          host: "ended.example.test",
          port: 443,
          createdAt: 1,
          launchId: "ffffffffffffffff",
          expiresAt: NOW + HOUR,
        },
        { host: "other.example.test", port: 443, repoHash: "other", createdAt: 1 },
      ]),
    );

    expect(await run(["sandbox", "egress", "list"], harness.deps)).toBe(0);
    expect(harness.stdout()).toBe(
      [
        "live.example.test for this repository permanently",
        `user.example.test:8443 for every repository until ${new Date(NOW + HOUR).toISOString()}`,
        "",
      ].join("\n"),
    );
  });

  it("lists the hosts the proxy denied with --denied", async () => {
    const harness = await harnessWith({
      denials: [
        {
          time: NOW,
          host: "blocked.example.test",
          port: 443,
          repoHash: "r",
          rule: "allowlist",
          reason: "not allowed",
        },
      ],
    });

    expect(await run(["sandbox", "egress", "list", "--denied"], harness.deps)).toBe(0);
    expect(harness.stdout()).toBe(
      `denied blocked.example.test at ${new Date(NOW).toISOString()}: not allowed\n`,
    );
  });

  it("says when there is nothing to list", async () => {
    const harness = await harnessWith();

    expect(await run(["sandbox", "egress", "list"], harness.deps)).toBe(0);
    expect(harness.stdout()).toBe("no active grants\n");
  });
});
