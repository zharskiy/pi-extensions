import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../../cli/index.ts";
import { readGrants } from "../../grants/index.ts";
import { sha256Hex } from "../../shared/index.ts";
import { createHarness } from "./harness.ts";

const NOW = 1_700_000_000_000;

describe("pi sandbox egress allow", () => {
  it("grants a host to every session", async () => {
    const harness = await createHarness();

    expect(await run(["sandbox", "egress", "allow", "Docs.Example.test"], harness.deps)).toBe(0);
    expect(await readGrants(harness.stateDir)).toEqual([
      { host: "docs.example.test", port: 443, createdAt: NOW },
    ]);
    expect(harness.stdout()).toBe("allowed docs.example.test\n");
  });

  it("grants a host:port", async () => {
    const harness = await createHarness();

    expect(await run(["sandbox", "egress", "allow", "git.example.test:8443"], harness.deps)).toBe(0);
    expect(await readGrants(harness.stateDir)).toEqual([
      { host: "git.example.test", port: 8443, createdAt: NOW },
    ]);
    expect(harness.stdout()).toBe("allowed git.example.test:8443\n");
  });

  it("refuses a host that egress.deny blocks, at any depth under a bare domain, and stores nothing", async () => {
    const harness = await createHarness();

    await harness.writeJson(harness.userConfigFile, {
      egress: { deny: ["paste.example.test", "*.files.test:8443"] },
    });

    expect(await run(["sandbox", "egress", "allow", "eu.paste.example.test"], harness.deps)).toBe(1);
    expect(harness.stderr()).toContain(
      "pi-sandbox: egress: eu.paste.example.test is denied by the egress.deny entry paste.example.test, which a grant cannot override\n  hint: pi sandbox config shows the layers that set egress.deny\n",
    );
    expect(await run(["sandbox", "egress", "allow", "a.files.test:8443"], harness.deps)).toBe(1);
    expect(await readGrants(harness.stateDir)).toEqual([]);
    expect(await run(["sandbox", "egress", "allow", "a.files.test"], harness.deps)).toBe(0);
    expect(await run(["sandbox", "egress", "allow", "files.test:8443"], harness.deps)).toBe(0);
  });

  it("refuses a target that is not a host name and an unknown option", async () => {
    const harness = await createHarness();

    expect(await run(["sandbox", "egress", "allow", "*.example.test"], harness.deps)).toBe(1);
    expect(harness.stderr()).toContain("egress: *.example.test must be a host name or host:port");
    expect(await run(["sandbox", "egress", "allow", "a.test", "--bogus", "1"], harness.deps)).toBe(1);
    expect(harness.stderr()).toContain(
      'pi-sandbox: unknown egress allow option "--bogus"\n  hint: pi sandbox egress allow <host[:port]>\n',
    );
    expect(await run(["sandbox", "egress", "allow", "a.test", "--user"], harness.deps)).toBe(1);
    expect(harness.stderr()).toContain('pi-sandbox: unknown egress allow option "--user"');
    expect(await run(["sandbox", "egress", "revoke", "a.test", "--user"], harness.deps)).toBe(1);
    expect(harness.stderr()).toContain('pi-sandbox: unknown egress revoke option "--user"');
    expect(await readGrants(harness.stateDir)).toEqual([]);
  });
});

describe("pi sandbox egress allow targets and arguments", () => {
  it.each([
    ["10.0.0.5", "must not be an IP address"],
    ["localhost", "must not name loopback"],
    ["docs.example.test:80", "names port 80, and plain HTTP is never forwarded"],
    ["docs.example.test:0x50", "must be a host name or host:port"],
    ["docs.example.test:1e3", "must be a host name or host:port"],
    ["docs.example.test:00443", "has a port that is not a number from 1 to 65535"],
  ])("refuses %s and stores nothing", async (target, problem) => {
    const harness = await createHarness();

    expect(await run(["sandbox", "egress", "allow", target], harness.deps)).toBe(1);
    expect(harness.stderr()).toContain(`pi-sandbox: egress: ${target} ${problem}`);
    expect(await readGrants(harness.stateDir)).toEqual([]);
  });

  it("grants a host whose labels hold underscores", async () => {
    const harness = await createHarness();

    expect(await run(["sandbox", "egress", "allow", "svc_a.corp.test"], harness.deps)).toBe(0);
    expect(await readGrants(harness.stateDir)).toEqual([
      { host: "svc_a.corp.test", port: 443, createdAt: NOW },
    ]);
  });

  it("refuses a second host", async () => {
    const harness = await createHarness();

    expect(await run(["sandbox", "egress", "allow", "a.test", "b.test"], harness.deps)).toBe(1);
    expect(harness.stderr()).toContain("egress allow: takes one host, got a.test b.test");
  });

  it("prints the usage of egress and of each action for -h and --help", async () => {
    const harness = await createHarness();

    expect(await run(["sandbox", "egress", "--help"], harness.deps)).toBe(0);
    expect(harness.stdout()).toMatch(
      /^usage: pi sandbox egress allow .*\| pi sandbox egress revoke .*\| pi sandbox egress list /,
    );

    expect(await run(["sandbox", "egress", "allow", "-h"], harness.deps)).toBe(0);
    expect(await run(["sandbox", "egress", "revoke", "--help"], harness.deps)).toBe(0);
    expect(await run(["sandbox", "egress", "list", "-h"], harness.deps)).toBe(0);
    expect(harness.stdout()).toContain("usage: pi sandbox egress allow <host[:port]>\n");
    expect(harness.stdout()).toContain("usage: pi sandbox egress revoke <host[:port]>\n");
    expect(harness.stdout()).toContain("usage: pi sandbox egress list ");
  });

  it("grants a host from a folder a launch refuses", async () => {
    const harness = await createHarness();
    const home = harness.deps.home;

    await mkdir(home, { recursive: true });

    expect(
      await run(["sandbox", "egress", "allow", "docs.example.test"], { ...harness.deps, cwd: home }),
    ).toBe(0);
    expect(await readGrants(harness.stateDir)).toHaveLength(1);
  });
});

describe("pi sandbox egress revoke and list", () => {
  it("revokes the grants of a host, every port unless one is named", async () => {
    const harness = await createHarness();

    await run(["sandbox", "egress", "allow", "docs.example.test"], harness.deps);

    await run(["sandbox", "egress", "allow", "docs.example.test:8443"], harness.deps);

    expect(await run(["sandbox", "egress", "revoke", "docs.example.test:8443"], harness.deps)).toBe(0);
    expect(harness.stdout()).toContain("revoked 1 grant for docs.example.test:8443\n");
    expect(await run(["sandbox", "egress", "revoke", "docs.example.test"], harness.deps)).toBe(0);
    expect(await readGrants(harness.stateDir)).toEqual([]);
    expect(await run(["sandbox", "egress", "revoke", "other.example.test"], harness.deps)).toBe(0);
    expect(harness.stdout()).toContain("revoked 0 grants for other.example.test\n");
  });

  it("refuses an unknown list option", async () => {
    const harness = await createHarness();

    expect(await run(["sandbox", "egress", "list", "--user"], harness.deps)).toBe(1);
    expect(harness.stderr()).toContain('pi-sandbox: unknown egress list option "--user"');
  });

  it("lists every grant and none stored for one repository", async () => {
    const harness = await createHarness();

    await writeFile(
      join(harness.stateDir, "grants.json"),
      JSON.stringify([
        { host: "mine.example.test", port: 443, repoHash: sha256Hex(harness.repoRoot), createdAt: 1 },
        { host: "user.example.test", port: 8443, createdAt: 1 },
        { host: "plain.example.test", port: 443, createdAt: 1 },
      ]),
    );

    expect(await run(["sandbox", "egress", "list"], harness.deps)).toBe(0);
    expect(harness.stdout()).toBe(["user.example.test:8443", "plain.example.test", ""].join("\n"));
  });

  it("lists the hosts the proxy denied with --denied", async () => {
    const harness = await createHarness({
      denials: [
        {
          time: NOW,
          host: "blocked.example.test",
          port: 443,
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
    const harness = await createHarness();

    expect(await run(["sandbox", "egress", "list"], harness.deps)).toBe(0);
    expect(harness.stdout()).toBe("no active grants\n");
  });
});
