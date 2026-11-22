import { spawn, spawnSync } from "node:child_process";
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
import { type AddressInfo, createServer } from "node:net";
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
  "sleep",
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

  await symlink(process.execPath, join(bin, "node"));
};

const sandboxRoot = async () => {
  const root = await realpath(await tempDir("entrypoint"));
  const paths = {
    root,
    home: join(root, "home"),
    render: join(root, "opt", "render"),
    bundle: join(root, "tmp"),
    system: join(root, "system.crt"),
    hostBin: join(root, "host-bin"),
    handover: join(root, "handover"),
    ready: join(root, "ready"),
    forward: join(root, "forward"),
  };

  await hostToolsBin(paths.hostBin);

  await mkdir(paths.render, { recursive: true });

  await mkdir(join(paths.root, "etc"), { recursive: true });

  await writeFile(paths.system, "SYSTEM\n");

  return paths;
};

type Paths = Awaited<ReturnType<typeof sandboxRoot>>;

const PROXY_OPTIONS = "-Dhttps.proxyHost=pi-sandbox-proxy -Dhttps.proxyPort=3128";

const withGuestPaths = (paths: Paths, text: string) => {
  const guestPaths: Record<string, string> = {
    "/tmp/pi-sandbox-handover": paths.handover,
    "/tmp/pi-sandbox-ready": paths.ready,
    "/tmp/pi-sandbox-forward": paths.forward,
    "/usr/local/lib/pi-sandbox/forwarder.mjs": join(launcherRoot(), "image", "forwarder.mjs"),
    "/opt/pi-sandbox/render": paths.render,
    "/tmp/pi-sandbox": paths.bundle,
    "/etc/ssl/certs/ca-certificates.crt": paths.system,
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

const RECORDING_KEYTOOL = 'touch "$(dirname "$0")/../../keytool-ran"';

interface RunOptions {
  command?: string[];
  env?: Record<string, string>;
  bin?: string;
  handoverTries?: number;
}

const entrypointRun = async (paths: Paths, options: RunOptions) => {
  await writeFile(join(paths.root, "bash-env.sh"), withGuestPaths(paths, await imageFile("bash-env.sh")));

  const script = withGuestPaths(paths, await imageFile("entrypoint.sh")).replace(
    /^handover_tries=\d+$/m,
    (line) => (options.handoverTries === undefined ? line : `handover_tries=${options.handoverTries}`),
  );
  const path = [options.bin, paths.hostBin].filter((entry) => entry !== undefined).join(":");

  return {
    args: ["-c", script, "entrypoint", ...(options.command ?? ["true"])],
    env: { PATH: path, HOME: paths.home, ...options.env },
  };
};

const spawnEntrypoint = async (paths: Paths, options: RunOptions = {}) => {
  const run = await entrypointRun(paths, options);

  return spawnSync("sh", run.args, { env: run.env, encoding: "utf8" });
};

const startEntrypoint = async (paths: Paths, options: RunOptions = {}) => {
  const run = await entrypointRun(paths, options);
  const child = spawn("sh", run.args, { env: run.env });
  const stderr: Buffer[] = [];

  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

  return new Promise<{ status: number | null; stderr: string }>((resolve) => {
    child.on("close", (status) => resolve({ status, stderr: Buffer.concat(stderr).toString("utf8") }));
  });
};

const settledWithin = (running: Promise<unknown>, ms: number) =>
  Promise.race([
    running.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
  ]);

const runEntrypoint = async (paths: Paths, options: RunOptions = {}) => {
  const result = await spawnEntrypoint(paths, options);

  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);

  return result.stdout;
};

const sourcingBashEnv = (paths: Paths, times: number) =>
  `${`. '${join(paths.root, "bash-env.sh")}'; `.repeat(times)}printf %s "$JAVA_TOOL_OPTIONS"`;

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

  it("marks the home ready as its last step, once the links are in place and before the command runs", async () => {
    const paths = await sandboxRoot();
    const script = (await imageFile("entrypoint.sh")).trimEnd().split("\n");
    const marked = script.indexOf(': > "$ready"');

    await mkdir(join(paths.render, "tools"));

    await writeFile(join(paths.render, "tools", "m2-settings.xml"), "<settings/>\n");

    const result = await spawnEntrypoint(paths, {
      command: ["sh", "-c", `test -e "${paths.ready}" && test -f "$HOME/.m2/settings.xml"`],
    });

    expect(script.slice(marked + 1).filter((line) => line.trim() !== "")).toEqual([
      'if [ "$#" -gt 0 ]; then',
      '  exec "$@"',
      "fi",
      "exec sleep infinity",
    ]);
    expect(result.status).toBe(0);
  });

  it("starts no forwarder when the services have no ports", async () => {
    const paths = await sandboxRoot();

    await runEntrypoint(paths);

    await expect(lstat(paths.forward)).rejects.toThrow();
  });

  it("starts the forwarder on the service ports before it marks the home ready", async () => {
    const paths = await sandboxRoot();
    const probe = createServer();
    const port = await new Promise<number>((resolve) => {
      probe.listen({ host: "127.0.0.1", port: 0 }, () => resolve((probe.address() as AddressInfo).port));
    });

    await new Promise((resolve) => probe.close(resolve));

    const connect = `require("node:net").connect(${port}, "127.0.0.1").on("connect", () => process.exit(0)).on("error", () => process.exit(3))`;
    const run = await entrypointRun(paths, {
      command: [
        "sh",
        "-c",
        `test -e "${paths.forward}" && ! test -s "${paths.forward}" && node -e '${connect}'`,
      ],
      env: {
        PI_SANDBOX_SERVICE_PORTS: String(port),
        PI_SANDBOX_SERVICES_HOST: "pi-sandbox-services.invalid",
      },
    });
    const child = spawn("sh", run.args, { env: run.env, detached: true, stdio: "ignore" });
    const status = await new Promise<number | null>((resolve) => child.on("exit", resolve));

    process.kill(-(child.pid ?? 0), "SIGKILL");

    expect(status).toBe(0);
    expect(await readFile(paths.ready, "utf8")).toBe("");
  });

  it("records why the forwarder failed and still marks the home ready for the launcher to report", async () => {
    const paths = await sandboxRoot();
    const taken = createServer();
    const port = await new Promise<number>((resolve) => {
      taken.listen({ host: "127.0.0.1", port: 0 }, () => resolve((taken.address() as AddressInfo).port));
    });

    const result = await spawnEntrypoint(paths, {
      env: {
        PI_SANDBOX_SERVICE_PORTS: String(port),
        PI_SANDBOX_SERVICES_HOST: "pi-sandbox-services.invalid",
      },
    });

    taken.close();

    expect(result.status).toBe(0);
    expect(await readFile(paths.forward, "utf8")).toContain(`port ${port} on 127.0.0.1`);
    expect(await readFile(paths.ready, "utf8")).toBe("");
  });

  it("leaves the home unmarked when it stops before the home is ready", async () => {
    const paths = await sandboxRoot();
    const result = await spawnEntrypoint(paths, {
      env: { PI_SANDBOX_AWAIT_HANDOVER: "1" },
      handoverTries: 1,
    });

    expect(result.status).toBe(1);
    await expect(lstat(paths.ready)).rejects.toThrow();
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

  it("links the rendered ~/.agents/skills into the home and keeps it out of the agent dir", async () => {
    const paths = await sandboxRoot();
    const agentsSkills = join(paths.home, ".agents", "skills");

    await mkdir(join(paths.render, "agents-skills", "deploy"), { recursive: true });

    await mkdir(join(agentsSkills, "planted"), { recursive: true });

    await runEntrypoint(paths);

    expect(await readlink(agentsSkills)).toBe(join(paths.render, "agents-skills"));
    await expect(lstat(join(paths.home, ".pi", "agent", "agents-skills"))).rejects.toThrow();
  });

  it("drops the ~/.agents/skills link once the render dir has none", async () => {
    const paths = await sandboxRoot();
    const agentsSkills = join(paths.home, ".agents", "skills");

    await mkdir(join(paths.render, "agents-skills"));

    await runEntrypoint(paths);

    await rm(join(paths.render, "agents-skills"), { recursive: true });

    await runEntrypoint(paths);

    await expect(lstat(agentsSkills)).rejects.toThrow();
  });

  it("links the rendered Maven settings into the home, replacing a planted link, and keeps the tool files out of the agent dir", async () => {
    const paths = await sandboxRoot();
    const settings = join(paths.home, ".m2", "settings.xml");

    await mkdir(join(paths.render, "tools"));

    await writeFile(join(paths.render, "tools", "m2-settings.xml"), "<settings/>\n");

    await mkdir(join(paths.home, ".m2"), { recursive: true });

    await symlink(join(paths.root, "planted.xml"), settings);

    await runEntrypoint(paths);

    expect(await readlink(settings)).toBe(join(paths.render, "tools", "m2-settings.xml"));
    expect(await readFile(settings, "utf8")).toBe("<settings/>\n");
    await expect(lstat(join(paths.home, ".pi", "agent", "tools"))).rejects.toThrow();
  });

  it("leaves the rendered status file in the render folder, linked nowhere", async () => {
    const paths = await sandboxRoot();

    await mkdir(join(paths.render, "tools"));

    await writeFile(join(paths.render, "tools", "status.json"), "{}\n");

    await runEntrypoint(paths);

    await expect(lstat(join(paths.home, ".pi", "agent", "tools"))).rejects.toThrow();
    await expect(lstat(join(paths.home, ".pi", "agent", "status.json"))).rejects.toThrow();
    expect(await readFile(join(paths.render, "tools", "status.json"), "utf8")).toBe("{}\n");
  });

  it("leaves the literal proxy of the rendered Maven settings as it is", async () => {
    const paths = await sandboxRoot();
    const proxy = "<proxy>\n<host>pi-sandbox-proxy</host>\n<port>3128</port>\n</proxy>\n";

    await mkdir(join(paths.render, "tools"));

    await writeFile(join(paths.render, "tools", "m2-settings.xml"), proxy);

    await runEntrypoint(paths);

    expect(await readFile(join(paths.home, ".m2", "settings.xml"), "utf8")).toBe(proxy);
  });

  it("puts ~/.m2/settings.xml in place only after the launcher hands over the ~/.m2 the engine made for a shared cache", async () => {
    const paths = await sandboxRoot();
    const m2 = join(paths.home, ".m2");

    await mkdir(join(paths.render, "tools"));

    await writeFile(join(paths.render, "tools", "m2-settings.xml"), "<settings/>\n");

    await mkdir(join(m2, "repository"), { recursive: true });

    await chmod(m2, 0o555);

    const running = startEntrypoint(paths, { env: { PI_SANDBOX_AWAIT_HANDOVER: "1" } });
    const settledBeforeHandover = await settledWithin(running, 500);

    await chmod(m2, 0o755);

    await writeFile(paths.handover, "");

    const result = await running;

    expect(settledBeforeHandover).toBe(false);
    expect(result).toEqual({ status: 0, stderr: "" });
    expect(await readFile(join(m2, "settings.xml"), "utf8")).toBe("<settings/>\n");
  });

  it("stops with a clear message when the launcher never hands the volumes over", async () => {
    const paths = await sandboxRoot();
    const result = await spawnEntrypoint(paths, {
      env: { PI_SANDBOX_AWAIT_HANDOVER: "1" },
      handoverTries: 10,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toBe(
      "pi-sandbox: the launcher did not hand the volumes to the sandbox user within 1 s, stopping\n",
    );
    await expect(lstat(join(paths.home, ".pi"))).rejects.toThrow();
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

  it("leaves the JDK, its cacerts and the proxy flags of JAVA_TOOL_OPTIONS alone, since the image layer trusts the CAs", async () => {
    const paths = await sandboxRoot();
    const bin = await installJdk(paths, RECORDING_KEYTOOL);
    const options = await runEntrypoint(paths, {
      command: ["sh", "-c", sourcingBashEnv(paths, 2)],
      env: { JAVA_TOOL_OPTIONS: PROXY_OPTIONS },
      bin,
    });

    expect(options).toBe(PROXY_OPTIONS);
    expect(await readFile(join(paths.root, "jdk", "lib", "security", "cacerts"), "utf8")).toBe("CACERTS\n");
    await expect(lstat(join(paths.root, "keytool-ran"))).rejects.toThrow();
  });

  it("writes no CA bundle or truststore at start", async () => {
    const paths = await sandboxRoot();

    await runEntrypoint(paths);

    await expect(lstat(join(paths.bundle, "ca-bundle.pem"))).rejects.toThrow();
    await expect(lstat(join(paths.bundle, "truststore.p12"))).rejects.toThrow();
  });
});
