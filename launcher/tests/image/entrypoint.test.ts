import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { launcherRoot } from "../../shared/index.ts";
import { tempDir } from "../support/temp-dir.ts";

const imageFile = (name: string) => readFile(join(launcherRoot(), "image", name), "utf8");

const HOST_TOOLS = [
  "sh",
  "find",
  "test",
  "cat",
  "mkdir",
  "rm",
  "ln",
  "basename",
  "dirname",
  "readlink",
  "awk",
  "cp",
  "chmod",
  "mv",
  "sed",
  "printf",
  "true",
];

const hostToolsBin = async (bin: string) => {
  await mkdir(bin);

  await Promise.all(
    HOST_TOOLS.map((name) => {
      const found = (process.env.PATH ?? "")
        .split(":")
        .map((dir) => join(dir, name))
        .find((path) => path.startsWith("/") && existsSync(path));

      return found === undefined ? Promise.resolve() : symlink(found, join(bin, name));
    }),
  );
};

const sandboxRoot = async () => {
  const root = await realpath(await tempDir("entrypoint"));
  const paths = {
    root,
    home: join(root, "home"),
    render: join(root, "opt", "render"),
    bundle: join(root, "tmp"),
    system: join(root, "system.crt"),
    trust: join(root, "etc", "ca.pem"),
    hostBin: join(root, "host-bin"),
  };

  await hostToolsBin(paths.hostBin);

  await mkdir(paths.render, { recursive: true });

  await mkdir(join(paths.root, "etc"), { recursive: true });

  await writeFile(paths.system, "SYSTEM\n");

  return paths;
};

type Paths = Awaited<ReturnType<typeof sandboxRoot>>;

const PROXY_OPTIONS = "-Dhttps.proxyHost=pi-sandbox-proxy -Dhttps.proxyPort=3128";

const trustFlags = (paths: Paths) =>
  `-Djavax.net.ssl.trustStore=${paths.bundle}/truststore.p12 -Djavax.net.ssl.trustStoreType=PKCS12 -Djavax.net.ssl.trustStorePassword=changeit`;

const certificate = (name: string) => `-----BEGIN CERTIFICATE-----\n${name}\n-----END CERTIFICATE-----\n`;

const withGuestPaths = (paths: Paths, text: string) => {
  const guestPaths: Record<string, string> = {
    "/opt/pi-sandbox/render": paths.render,
    "/tmp/pi-sandbox": paths.bundle,
    "/etc/ssl/certs/ca-certificates.crt": paths.system,
    "/etc/pi-sandbox/ca.pem": paths.trust,
    "/usr/local/lib/pi-sandbox/bash-env.sh": join(paths.root, "bash-env.sh"),
  };
  const guestPath = new RegExp(
    Object.keys(guestPaths)
      .map((path) => path.replaceAll(".", "\\."))
      .join("|"),
    "g",
  );

  return text.replace(guestPath, (path) => guestPaths[path] ?? path);
};

const installJdk = async (paths: Paths, keytool: string) => {
  const jdk = join(paths.root, "jdk");
  const bin = join(paths.root, "bin");

  await mkdir(join(jdk, "bin"), { recursive: true });

  await mkdir(join(jdk, "lib", "security"), { recursive: true });

  await mkdir(bin);

  await writeFile(join(jdk, "lib", "security", "cacerts"), "CACERTS\n");

  await writeFile(join(jdk, "bin", "java"), "#!/bin/sh\n");

  await writeFile(join(jdk, "bin", "keytool"), `#!/bin/sh\n${keytool}\n`);

  await chmod(join(jdk, "bin", "java"), 0o755);

  await chmod(join(jdk, "bin", "keytool"), 0o755);

  await symlink(join(jdk, "bin", "java"), join(bin, "java"));

  return bin;
};

const IMPORTING_KEYTOOL =
  'store="$4"; alias="$8"; shift 9; printf \'%s %s\\n\' "$alias" "$(sed -n 2p "$1")" >> "$store"';

const FAILING_KEYTOOL = "exit 1";

interface RunOptions {
  command?: string[];
  env?: Record<string, string>;
  bin?: string;
}

const spawnEntrypoint = async (paths: Paths, options: RunOptions = {}) => {
  await writeFile(join(paths.root, "bash-env.sh"), withGuestPaths(paths, await imageFile("bash-env.sh")));

  const script = withGuestPaths(paths, await imageFile("entrypoint.sh"));
  const path = [options.bin, paths.hostBin].filter((entry) => entry !== undefined).join(":");

  return spawnSync("sh", ["-c", script, "entrypoint", ...(options.command ?? ["true"])], {
    env: { PATH: path, HOME: paths.home, ...options.env },
    encoding: "utf8",
  });
};

const runEntrypoint = async (paths: Paths, options: RunOptions = {}) => {
  const result = await spawnEntrypoint(paths, options);

  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);

  return result.stdout;
};

const sourcingBashEnv = (paths: Paths, times: number) =>
  `${`. '${join(paths.root, "bash-env.sh")}'; `.repeat(times)}printf %s "$JAVA_TOOL_OPTIONS"`;

const javaOptionsAfterStart = (paths: Paths, bin?: string) =>
  runEntrypoint(paths, {
    command: ["sh", "-c", sourcingBashEnv(paths, 1)],
    env: { JAVA_TOOL_OPTIONS: PROXY_OPTIONS },
    bin,
  });

describe("image entrypoint", () => {
  it("links every rendered entry, replacing a file or dir an agent put in place of a link", async () => {
    const paths = await sandboxRoot();
    const agent = join(paths.home, ".pi", "agent");

    await writeFile(join(paths.render, "models.json"), '{"rendered":true}\n');

    await mkdir(join(paths.render, "skills"));

    await mkdir(join(agent, "skills", "planted"), { recursive: true });

    await writeFile(join(agent, "models.json"), '{"planted":true}\n');

    await runEntrypoint(paths);

    expect(await readlink(join(agent, "models.json"))).toBe(join(paths.render, "models.json"));
    expect(await readlink(join(agent, "skills"))).toBe(join(paths.render, "skills"));
  });

  it("gives pi a read-only copy of auth.json, so its lock lands in the agent dir, not the read-only render dir", async () => {
    const paths = await sandboxRoot();
    const agent = join(paths.home, ".pi", "agent");
    const auth = join(agent, "auth.json");

    await writeFile(join(paths.render, "auth.json"), '{"rendered":true}\n');

    await runEntrypoint(paths);

    await writeFile(join(paths.render, "auth.json"), '{"rendered":2}\n');

    await runEntrypoint(paths);

    const stats = await lstat(auth);

    expect(stats.isFile()).toBe(true);
    expect(stats.mode & 0o777).toBe(0o444);
    expect(await readFile(auth, "utf8")).toBe('{"rendered":2}\n');
    expect((await readdir(agent)).filter((name) => name.startsWith("auth.json."))).toEqual([]);
  });

  it("replaces a file, dir or link an agent put in place of the auth.json copy", async () => {
    const planted = async (plant: (auth: string, root: string) => Promise<void>) => {
      const paths = await sandboxRoot();
      const auth = join(paths.home, ".pi", "agent", "auth.json");

      await writeFile(join(paths.render, "auth.json"), '{"rendered":true}\n');

      await mkdir(join(paths.home, ".pi", "agent"), { recursive: true });

      await plant(auth, paths.root);

      await runEntrypoint(paths);

      return { stats: await lstat(auth), text: await readFile(auth, "utf8") };
    };

    const results = await Promise.all([
      planted((auth) => writeFile(auth, '{"planted":true}\n')),
      planted(async (auth) => {
        await mkdir(join(auth, "inner"), { recursive: true });
      }),
      planted(async (auth, root) => {
        await mkdir(join(root, "elsewhere"));

        await symlink(join(root, "elsewhere"), auth);
      }),
    ]);

    expect(results.map(({ stats, text }) => [stats.isFile(), text])).toEqual([
      [true, '{"rendered":true}\n'],
      [true, '{"rendered":true}\n'],
      [true, '{"rendered":true}\n'],
    ]);
  });

  it("links hidden rendered entries too", async () => {
    const paths = await sandboxRoot();

    await writeFile(join(paths.render, ".hidden.json"), "{}\n");

    await runEntrypoint(paths);

    expect(await readlink(join(paths.home, ".pi", "agent", ".hidden.json"))).toBe(
      join(paths.render, ".hidden.json"),
    );
  });

  it("fails when an agent dir entry cannot be replaced by its render link", async () => {
    const paths = await sandboxRoot();
    const locked = join(paths.home, ".pi", "agent", "skills", "locked");

    await mkdir(join(paths.render, "skills"));

    await mkdir(locked, { recursive: true });

    await writeFile(join(locked, "file"), "x\n");

    await chmod(locked, 0o555);

    const result = await spawnEntrypoint(paths);

    await chmod(locked, 0o755);

    expect(result.status).not.toBe(0);
  });

  it("idles with a plain sleep under the container's own init and leaves the bash env to the shells", async () => {
    const script = await imageFile("entrypoint.sh");

    expect(script.trimEnd().split("\n").at(-1)).toBe("exec sleep infinity");
    expect(script).not.toContain("tini");
    expect(script).not.toContain("bash-env.sh");
  });

  it("drops dangling links into the render dir", async () => {
    const paths = await sandboxRoot();
    const agent = join(paths.home, ".pi", "agent");

    await mkdir(agent, { recursive: true });

    await writeFile(join(paths.render, "models.json"), "{}\n");

    await runEntrypoint(paths);

    await rm(join(paths.render, "models.json"));

    await runEntrypoint(paths);

    await expect(lstat(join(agent, "models.json"))).rejects.toThrow();
  });

  it("links the rendered tool files into the home and keeps them out of the agent dir", async () => {
    const paths = await sandboxRoot();

    await mkdir(join(paths.render, "tools"));

    await writeFile(join(paths.render, "tools", "m2-settings.xml"), "<settings/>\n");

    await mkdir(join(paths.home, ".m2"), { recursive: true });

    await writeFile(join(paths.home, ".m2", "settings.xml"), "<planted/>\n");

    await runEntrypoint(paths);

    expect(await readlink(join(paths.home, ".m2", "settings.xml"))).toBe(
      join(paths.render, "tools", "m2-settings.xml"),
    );
    await expect(lstat(join(paths.home, ".pi", "agent", "tools"))).rejects.toThrow();
  });

  it("puts the gh, npm and pip files in place and writable copies of the gitconfig and the glab config", async () => {
    const paths = await sandboxRoot();
    const tools = join(paths.render, "tools");
    const names = ["gh-hosts.yml", "npmrc", "pip.conf", "glab-config.yml", "gitconfig"];

    await mkdir(tools);

    await Promise.all(names.map((name) => writeFile(join(tools, name), `${name}\n`)));

    await mkdir(join(paths.home, ".config", "glab-cli"), { recursive: true });

    await writeFile(join(paths.home, ".gitconfig"), "planted\n");

    await runEntrypoint(paths);

    expect(await readlink(join(paths.home, ".config", "gh", "hosts.yml"))).toBe(join(tools, "gh-hosts.yml"));
    expect(await readlink(join(paths.home, ".npmrc"))).toBe(join(tools, "npmrc"));
    expect(await readlink(join(paths.home, ".config", "pip", "pip.conf"))).toBe(join(tools, "pip.conf"));

    const glab = join(paths.home, ".config", "glab-cli", "config.yml");
    const gitconfig = join(paths.home, ".gitconfig");

    expect((await lstat(glab)).isSymbolicLink()).toBe(false);
    expect((await lstat(glab)).mode & 0o777).toBe(0o600);
    expect(await readFile(glab, "utf8")).toBe("glab-config.yml\n");
    expect((await lstat(gitconfig)).isFile()).toBe(true);
    expect(await readFile(gitconfig, "utf8")).toBe("gitconfig\n");
  });

  it("builds a JVM truststore from the JDK cacerts and every proxy CA cert and adds the trust flags", async () => {
    const paths = await sandboxRoot();
    const bin = await installJdk(paths, IMPORTING_KEYTOOL);

    await writeFile(paths.trust, `${certificate("PROXY")}${certificate("CORP")}`);

    expect(await javaOptionsAfterStart(paths, bin)).toBe(`${PROXY_OPTIONS} ${trustFlags(paths)}`);
    expect((await readFile(join(paths.bundle, "truststore.p12"), "utf8")).split("\n").sort()).toEqual([
      "",
      "CACERTS",
      "pi-sandbox-1 PROXY",
      "pi-sandbox-2 CORP",
    ]);
  });

  it("adds the trust flags once when a shell sources the bash env again", async () => {
    const paths = await sandboxRoot();
    const bin = await installJdk(paths, IMPORTING_KEYTOOL);

    await writeFile(paths.trust, certificate("PROXY"));

    const options = await runEntrypoint(paths, {
      command: ["sh", "-c", sourcingBashEnv(paths, 2)],
      env: { JAVA_TOOL_OPTIONS: PROXY_OPTIONS },
      bin,
    });

    expect(options).toBe(`${PROXY_OPTIONS} ${trustFlags(paths)}`);
  });

  it("leaves JAVA_TOOL_OPTIONS without trust flags when keytool fails", async () => {
    const paths = await sandboxRoot();
    const bin = await installJdk(paths, FAILING_KEYTOOL);

    await writeFile(paths.trust, certificate("PROXY"));

    expect(await javaOptionsAfterStart(paths, bin)).toBe(PROXY_OPTIONS);
    await expect(lstat(join(paths.bundle, "truststore.p12"))).rejects.toThrow();
  });

  it("leaves JAVA_TOOL_OPTIONS without trust flags when the image has no java", async () => {
    const paths = await sandboxRoot();

    await writeFile(paths.trust, certificate("PROXY"));

    expect(await javaOptionsAfterStart(paths)).toBe(PROXY_OPTIONS);
    await expect(lstat(join(paths.bundle, "truststore.p12"))).rejects.toThrow();
  });

  it("appends the mounted trust bundle to the CA bundle", async () => {
    const paths = await sandboxRoot();

    await writeFile(paths.trust, "TRUST\n");

    await runEntrypoint(paths);

    expect(await readFile(join(paths.bundle, "ca-bundle.pem"), "utf8")).toBe("SYSTEM\nTRUST\n");
  });
});
