import { writeFile } from "node:fs/promises";
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
    expect(harness.stdout()).toBe("allowed docs.example.test for this repository\n");
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
    expect(harness.stderr()).toContain("egress: *.example.test is not a host or host:port");
    expect(await run(["sandbox", "egress", "allow", "a.test", "--bogus", "1"], harness.deps)).toBe(1);
    expect(harness.stderr()).toContain(
      'pi-sandbox: unknown egress allow option "--bogus"\n  hint: pi sandbox egress allow <host[:port]> [--user]\n',
    );
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

  it("lists the grants of this repository and the user-wide ones, only the latter with --user", async () => {
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
    expect(await run(["sandbox", "egress", "list", "--user"], harness.deps)).toBe(0);
    expect(harness.stdout()).toContain("user.example.test:8443 for every repository\n");
    expect(harness.stdout().split("mine.example.test")).toHaveLength(2);
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
