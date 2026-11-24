import { spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { launcherRoot } from "../../shared/index.ts";
import { tempDir } from "../support/temp-dir.ts";

const FAKE_KEYTOOL = `#!/bin/sh
cat >/dev/null
case "$*" in
  *-importcert*) echo imported >> "$(dirname "$0")/imports" ;;
esac
`;

const setup = async () => {
  const root = await tempDir("trust-jdk");
  const script = (await readFile(join(launcherRoot(), "image", "trust-jdk.sh"), "utf8"))
    .replace("ca_dir=/usr/local/share/ca-certificates/pinata", `ca_dir=${root}/ca`)
    .replace("net_lines=/usr/local/lib/pinata/jdk-net.properties", `net_lines=${root}/net-lines`)
    .replace("find / -xdev", `find ${root}/jdks -xdev`);

  await mkdir(join(root, "ca"), { recursive: true });
  await mkdir(join(root, "jdks"), { recursive: true });
  await writeFile(join(root, "ca", "one.crt"), "pem\n");
  await writeFile(join(root, "ca", "two.crt"), "pem\n");
  await writeFile(join(root, "net-lines"), "http.proxyHost=proxy\n");
  await writeFile(join(root, "trust.sh"), script);

  return root;
};

const jdk = async (root: string, name: string, complete: boolean) => {
  const home = join(root, "jdks", name);

  await mkdir(join(home, "bin"), { recursive: true });
  await writeFile(join(home, "bin", "keytool"), FAKE_KEYTOOL);
  await chmod(join(home, "bin", "keytool"), 0o755);

  if (complete) {
    await mkdir(join(home, "conf"), { recursive: true });
    await mkdir(join(home, "lib", "security"), { recursive: true });
    await writeFile(join(home, "conf", "net.properties"), "");
    await writeFile(join(home, "lib", "security", "cacerts"), "");
  }

  return home;
};

const run = (root: string, args: string[] = []) =>
  spawnSync("sh", [join(root, "trust.sh"), ...args], { encoding: "utf8" });

describe("trust-jdk.sh", () => {
  it("warns about and skips a discovered keytool without cacerts or net.properties", async () => {
    const root = await setup();
    const stray = await jdk(root, "a-stray", false);

    await jdk(root, "b-real", true);

    const result = run(root);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain(`skipping ${stray} has no lib/security/cacerts`);
    expect(result.stdout).toContain("b-real trusts the sandbox CAs");
  });

  it("fails on a stray keytool passed as an argument", async () => {
    const root = await setup();
    const stray = await jdk(root, "stray", false);

    const result = run(root, [stray]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${stray} has no lib/security/cacerts`);
  });

  it("keeps keytool from reading the discovery loop's stdin", async () => {
    const root = await setup();

    await jdk(root, "a", true);
    await jdk(root, "b", true);

    const result = run(root);

    expect(result.status).toBe(0);
    expect(result.stdout.match(/trusts the sandbox CAs/g)).toHaveLength(2);
  });
});
