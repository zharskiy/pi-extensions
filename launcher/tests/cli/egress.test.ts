import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../../cli/index.ts";
import { readGrants } from "../../grants/index.ts";
import { sha256Hex } from "../../shared/index.ts";
import { createHarness } from "./harness.ts";

const NOW = 1_700_000_000_000;

describe("pi sandbox egress allow", () => {
  it("grants a host to this repository", async () => {
    const harness = await createHarness();

    expect(await run(["sandbox", "egress", "allow", "Docs.Example.test"], harness.deps)).toBe(0);
    expect(await readGrants(harness.stateDir)).toEqual([
      { host: "docs.example.test", port: 443, repoHash: sha256Hex(harness.repoRoot), createdAt: NOW },
    ]);
    expect(harness.stdout()).toBe(`allowed docs.example.test for ${harness.repoRoot}\n`);
  });

  it("grants a host:port to every repository with --user", async () => {
    const harness = await createHarness();

    expect(await run(["sandbox", "egress", "allow", "git.example.test:8443", "--user"], harness.deps)).toBe(
      0,
    );
    expect(await readGrants(harness.stateDir)).toEqual([
      { host: "git.example.test", port: 8443, createdAt: NOW },
    ]);
    expect(harness.stdout()).toBe("allowed git.example.test:8443 for every repository\n");
  });

  it("refuses a grant when egress.grants is off and stores nothing", async () => {
    const harness = await createHarness();

    await harness.writeJson(harness.policyFile, { egress: { grants: false } });

    expect(await run(["sandbox", "egress", "allow", "docs.example.test"], harness.deps)).toBe(1);
    expect(harness.stderr()).toContain("egress grants are turned off by egress.grants");
    expect(await readGrants(harness.stateDir)).toEqual([]);
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
      'pi-sandbox: unknown egress allow option "--bogus"\n  hint: pi sandbox egress allow <host[:port]> [--user]\n',
    );
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
      { host: "svc_a.corp.test", port: 443, repoHash: sha256Hex(harness.repoRoot), createdAt: NOW },
    ]);
  });

  it("takes the flag before the host and refuses a second host", async () => {
    const harness = await createHarness();

    expect(await run(["sandbox", "egress", "allow", "--user", "docs.example.test"], harness.deps)).toBe(0);
    expect(await readGrants(harness.stateDir)).toEqual([
      { host: "docs.example.test", port: 443, createdAt: NOW },
    ]);
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
    expect(harness.stdout()).toContain("usage: pi sandbox egress allow <host[:port]> [--user]\n");
    expect(harness.stdout()).toContain("usage: pi sandbox egress revoke <host[:port]> [--user]\n");
    expect(harness.stdout()).toContain("usage: pi sandbox egress list ");
  });

  it("refuses a repository grant in a folder a launch refuses, and allows a user grant there", async () => {
    const harness = await createHarness();
    const home = harness.deps.home;

    await mkdir(home, { recursive: true });

    const deps = { ...harness.deps, cwd: home };

    expect(await run(["sandbox", "egress", "allow", "docs.example.test"], deps)).toBe(1);
    expect(harness.stderr()).toContain(`pi-sandbox: ${home} would mount ${home} into the sandbox, refusing`);
    expect(await readGrants(harness.stateDir)).toEqual([]);
    expect(await run(["sandbox", "egress", "allow", "docs.example.test", "--user"], deps)).toBe(0);
  });
});

describe("pi sandbox egress revoke and list", () => {
  it("revokes this repository's grants for a host, and user grants with --user", async () => {
    const harness = await createHarness();

    await run(["sandbox", "egress", "allow", "docs.example.test"], harness.deps);

    await run(["sandbox", "egress", "allow", "docs.example.test", "--user"], harness.deps);

    expect(await run(["sandbox", "egress", "revoke", "docs.example.test"], harness.deps)).toBe(0);
    expect(harness.stdout()).toContain("revoked 1 grant for docs.example.test\n");
    expect(await readGrants(harness.stateDir)).toEqual([
      expect.not.objectContaining({ repoHash: expect.anything() }),
    ]);

    expect(await run(["sandbox", "egress", "revoke", "docs.example.test", "--user"], harness.deps)).toBe(0);
    expect(await readGrants(harness.stateDir)).toEqual([]);
  });

  it("names the scope that holds the grant when the revoke found none in its own", async () => {
    const harness = await createHarness();

    await run(["sandbox", "egress", "allow", "docs.example.test", "--user"], harness.deps);

    expect(await run(["sandbox", "egress", "revoke", "docs.example.test"], harness.deps)).toBe(1);
    expect(harness.stderr()).toContain(
      "pi-sandbox: egress: docs.example.test has no grant for this repository; its grant is for every repository\n  hint: pi sandbox egress revoke docs.example.test --user\n",
    );
    expect(await readGrants(harness.stateDir)).toHaveLength(1);
    expect(await run(["sandbox", "egress", "revoke", "other.example.test"], harness.deps)).toBe(0);
    expect(harness.stdout()).toContain("revoked 0 grants for other.example.test\n");
  });

  it("says grants are off instead of listing stored grants the proxy ignores", async () => {
    const harness = await createHarness();

    await writeFile(
      join(harness.stateDir, "grants.json"),
      JSON.stringify([{ host: "user.example.test", port: 443, createdAt: 1 }]),
    );
    await harness.writeJson(harness.policyFile, { egress: { grants: false } });

    expect(await run(["sandbox", "egress", "list"], harness.deps)).toBe(0);
    expect(harness.stdout()).toBe("grants are turned off by egress.grants\n");
  });

  it("takes no --user, since the list names each grant's scope", async () => {
    const harness = await createHarness();

    expect(await run(["sandbox", "egress", "list", "--user"], harness.deps)).toBe(1);
    expect(harness.stderr()).toContain('pi-sandbox: unknown egress list option "--user"');
  });

  it("lists the grants of this repository and the user-wide ones", async () => {
    const harness = await createHarness();

    await writeFile(
      join(harness.stateDir, "grants.json"),
      JSON.stringify([
        { host: "mine.example.test", port: 443, repoHash: sha256Hex(harness.repoRoot), createdAt: 1 },
        { host: "user.example.test", port: 8443, createdAt: 1 },
        { host: "other.example.test", port: 443, repoHash: "other", createdAt: 1 },
      ]),
    );

    expect(await run(["sandbox", "egress", "list"], harness.deps)).toBe(0);
    expect(harness.stdout()).toBe(
      ["mine.example.test for this repository", "user.example.test:8443 for every repository", ""].join("\n"),
    );
  });

  it("lists the hosts the proxy denied with --denied", async () => {
    const harness = await createHarness({
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
    const harness = await createHarness();

    expect(await run(["sandbox", "egress", "list"], harness.deps)).toBe(0);
    expect(harness.stdout()).toBe("no active grants\n");
  });
});
