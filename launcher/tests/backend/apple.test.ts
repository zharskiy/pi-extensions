import { statSync } from "node:fs";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createAppleBackend } from "../../backend/apple/backend.ts";
import type { ContainerSpec } from "../../backend/index.ts";
import { createFakeContainerCli } from "../support/fake-container-cli.ts";
import { createFakeRunner } from "../support/fake-runner.ts";

const IMAGE = "example.test/pi-sandbox:1";

const DIGEST = `sha256:${"d".repeat(64)}`;

const SWITCHES = new Set(["--read-only", "--init", "--ssh", "--no-dns", "--interactive", "--tty"]);

const spec: ContainerSpec = {
  name: "pi-sandbox-abc",
  image: IMAGE,
  labels: { "pi-sandbox.repo-hash": "abc" },
  mounts: [
    { kind: "bind", source: "/work/repo", target: "/work/repo", readOnly: false },
    { kind: "bind", source: "/work/repo/.git/hooks", target: "/work/repo/.git/hooks", readOnly: true },
    { kind: "volume", source: "pi-sandbox-agent-u1", target: "/home/pi/.pi/agent", readOnly: false },
  ],
  network: { kind: "internal", name: "pi-sandbox" },
  env: { TERM: "xterm-256color" },
  workdir: "/work/repo",
  user: "501:20",
  readOnlyRoot: true,
  tmpfs: ["/tmp"],
  init: true,
  resources: { cpus: 2, memoryGiB: 1.5 },
};

interface Parsed {
  pairs: string[];
  switches: string[];
  positional: string[];
}

const parse = (args: string[], parsed: Parsed = { pairs: [], switches: [], positional: [] }): Parsed => {
  const [head, ...rest] = args;

  if (head === undefined) {
    return parsed;
  }

  if (parsed.positional.length > 0 || !head.startsWith("--")) {
    return { ...parsed, positional: [...parsed.positional, ...args] };
  }

  if (SWITCHES.has(head)) {
    return parse(rest, { ...parsed, switches: [...parsed.switches, head] });
  }

  const [value = "", ...remaining] = rest;

  return parse(remaining, { ...parsed, pairs: [...parsed.pairs, `${head} ${value}`] });
};

const readyCli = async () => {
  const cli = createFakeContainerCli({ registry: { [IMAGE]: DIGEST } });
  const backend = createAppleBackend({ runner: cli.runner, spawn: cli.spawn });

  await backend.pullImage(IMAGE);

  return { cli, backend };
};

const lastCall = (calls: Array<{ args: string[] }>, command: string) =>
  calls.filter((call) => call.args[0] === command).at(-1)?.args ?? [];

const output = () => {
  const stream = new PassThrough();
  const chunks: string[] = [];

  stream.on("data", (chunk: Buffer) => chunks.push(chunk.toString("utf8")));

  return { stream, text: () => chunks.join("") };
};

describe("apple adapter", () => {
  it("declares its capabilities", () => {
    const backend = createAppleBackend({ runner: createFakeContainerCli().runner });

    expect(backend.capabilities).toEqual({ singleFileMount: false, sshAgent: true, internalNetwork: true });
  });

  it("translates the container spec into container create flags", async () => {
    const { cli, backend } = await readyCli();

    await backend.createContainer(spec);

    const [command, ...args] = lastCall(cli.calls, "create");
    const parsed = parse(args);

    expect(command).toBe("create");
    expect(cli.envFiles.at(-1)).toBe("TERM=xterm-256color\n");
    expect(new Set(parsed.pairs.filter((pair) => !pair.startsWith("--env-file ")))).toEqual(
      new Set([
        "--name pi-sandbox-abc",
        "--label pi-sandbox.repo-hash=abc",
        "--mount type=bind,source=/work/repo,target=/work/repo",
        "--mount type=bind,source=/work/repo/.git/hooks,target=/work/repo/.git/hooks,readonly",
        "--volume pi-sandbox-agent-u1:/home/pi/.pi/agent",
        "--network pi-sandbox",
        "--user 501:20",
        "--tmpfs /tmp",
        "--workdir /work/repo",
        "--cpus 2",
        "--memory 1536M",
      ]),
    );
    expect(new Set(parsed.switches)).toEqual(new Set(["--no-dns", "--read-only", "--init"]));
    expect(parsed.positional).toEqual([IMAGE]);
  });

  it("passes the environment through a private env file that is gone after the call, never in argv", async () => {
    const { cli, backend } = await readyCli();
    const token = "http://pi-sandbox:REPO-TOKEN-1@192.168.66.1:3128";
    const { id } = await backend.createContainer({ ...spec, env: { HTTPS_PROXY: token, TERM: "xterm" } });

    await backend.startContainer(id);

    await backend.exec(
      { containerId: id, command: ["true"], env: { PI_SANDBOX_LAUNCH_ID: "l1", LANG: "C" }, workdir: "/" },
      { stdout: new PassThrough(), stderr: new PassThrough(), tty: false },
    );

    const argv = [...cli.calls.map((call) => call.args), ...cli.spawned.map((call) => call.args)].flat();
    const envFile =
      lastCall(cli.calls, "create")[lastCall(cli.calls, "create").indexOf("--env-file") + 1] ?? "";

    expect(argv.join(" ")).not.toMatch(/REPO-TOKEN-1|--env /);
    expect(cli.envFiles).toEqual([`HTTPS_PROXY=${token}\nTERM=xterm\n`, "PI_SANDBOX_LAUNCH_ID=l1\nLANG=C\n"]);
    expect(() => statSync(envFile)).toThrow();
  });

  it("refuses an environment value with a line break", async () => {
    const { backend } = await readyCli();

    await expect(backend.createContainer({ ...spec, env: { BAD: "a\nINJECTED=1" } })).rejects.toThrow(
      "environment variable BAD has a line break; it cannot be passed",
    );
  });

  it("forwards the ssh agent with --ssh when the spec asks for it", async () => {
    const { cli, backend } = await readyCli();

    await backend.createContainer({
      ...spec,
      network: { kind: "none" },
      sshAgent: { guestSocket: "/run/agent.sock" },
    });

    const parsed = parse(lastCall(cli.calls, "create").slice(1));

    expect(parsed.switches).toContain("--ssh");
    expect(cli.envFiles.at(-1)).toContain("SSH_AUTH_SOCK=/var/host-services/ssh-auth.sock\n");
    expect(parsed.pairs).toContain("--network none");
  });

  it("does not forward the ssh agent unless the spec asks for it", async () => {
    const { cli, backend } = await readyCli();

    await backend.createContainer(spec);

    const parsed = parse(lastCall(cli.calls, "create").slice(1));

    expect(parsed.switches).not.toContain("--ssh");
    expect(cli.envFiles.at(-1)).not.toContain("SSH_AUTH_SOCK");
  });

  it("runs a tty exec on the host terminal with env and workdir", async () => {
    const { cli, backend } = await readyCli();
    const { id } = await backend.createContainer(spec);

    await backend.startContainer(id);

    const exitCode = await backend.exec(
      { containerId: id, command: ["pi", "--help"], env: { COLUMNS: "120" }, workdir: "/work/repo/sub" },
      { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), tty: true },
    );
    const call = cli.calls.at(-1);
    const parsed = parse(call?.args.slice(1) ?? []);

    expect(exitCode).toBe(0);
    expect(call?.interactive).toBe(true);
    expect(new Set(parsed.switches)).toEqual(new Set(["--interactive", "--tty"]));
    expect(parsed.pairs.filter((pair) => !pair.startsWith("--env-file "))).toEqual([
      "--workdir /work/repo/sub",
    ]);
    expect(cli.envFiles.at(-1)).toBe("COLUMNS=120\n");
    expect(parsed.positional).toEqual([id, "pi", "--help"]);
  });

  it("pipes a non-tty exec through the given streams and passes stdin", async () => {
    const { cli, backend } = await readyCli();
    const { id } = await backend.createContainer(spec);
    const stdout = output();
    const stderr = output();
    const stdin = new PassThrough();

    await backend.startContainer(id);

    stdin.end("typed input");

    const exitCode = await backend.exec(
      { containerId: id, command: ["sh", "-c", "echo out; echo err >&2; exit 4"], env: {}, workdir: "/" },
      { stdin, stdout: stdout.stream, stderr: stderr.stream, tty: false },
    );

    expect(exitCode).toBe(4);
    expect(stdout.text()).toBe("out\n");
    expect(stderr.text()).toBe("err\n");
    expect(cli.spawned.at(-1)?.input).toBe("typed input");
    expect(cli.calls.some((call) => call.interactive)).toBe(false);
  });

  it("pulls a pinned image by digest and returns the pinned reference as its id", async () => {
    const cli = createFakeContainerCli({ registry: { [IMAGE]: DIGEST } });
    const backend = createAppleBackend({ runner: cli.runner });

    expect(await backend.pullImage(IMAGE, DIGEST)).toEqual({
      id: `example.test/pi-sandbox@${DIGEST}`,
      digest: DIGEST,
    });
    expect(lastCall(cli.calls, "image")).toEqual(["image", "inspect", `example.test/pi-sandbox@${DIGEST}`]);
    expect(cli.calls.map((call) => call.args.slice(0, 3).join(" "))).toContain(
      `image pull example.test/pi-sandbox@${DIGEST}`,
    );
  });

  it("passes build args to the build as --build-arg pairs", async () => {
    const cli = createFakeContainerCli();
    const backend = createAppleBackend({ runner: cli.runner });

    await backend.buildImage("/ctx", "pi-sandbox:dev", { HTTPS_PROXY: "http://proxy.example.com:8080" });

    expect(parse(lastCall(cli.calls, "build").slice(1)).pairs).toEqual([
      "--build-arg HTTPS_PROXY=http://proxy.example.com:8080",
      "--tag pi-sandbox:dev",
      "--file /ctx/Dockerfile",
    ]);
  });

  it("resolves a local image and reports an absent one as undefined", async () => {
    const { backend } = await readyCli();

    expect(await backend.resolveImage(IMAGE)).toEqual({ id: IMAGE, digest: DIGEST });
    expect(await backend.resolveImage("example.test/absent:1")).toBeUndefined();
  });

  it("creates the internal proxy network once and routes to its gateway", async () => {
    const { cli, backend } = await readyCli();

    expect(await backend.prepareProxyRoute(3128, "a".repeat(64), "image")).toEqual({
      network: { kind: "internal", name: "pi-sandbox" },
      address: "192.168.66.1:3128",
    });

    await backend.prepareProxyRoute(3128, "a".repeat(64), "image");

    expect(cli.networks.get("pi-sandbox")).toEqual({ internal: true, labels: ["pi-sandbox.managed=true"] });
    expect(cli.calls.filter((call) => call.args.slice(0, 2).join(" ") === "network create")).toHaveLength(1);
  });

  it("gives each repository its own internal network and removes it with the repository's last container", async () => {
    const { cli, backend } = await readyCli();
    const repoA = "a".repeat(64);
    const repoB = "b".repeat(64);
    const routeA = await backend.prepareProxyRoute(3128, "p".repeat(64), "image", repoA);
    const routeB = await backend.prepareProxyRoute(3128, "p".repeat(64), "image", repoB);
    const create = (name: string, repo: string) =>
      backend.createContainer({
        ...spec,
        name,
        labels: { "pi-sandbox.repo-hash": repo },
        network: repo === repoA ? routeA.network : routeB.network,
      });

    expect(routeA.network).toEqual({ kind: "internal", name: `pi-sandbox-${"a".repeat(12)}` });
    expect(cli.networks.get(`pi-sandbox-${"a".repeat(12)}`)).toEqual({
      internal: true,
      labels: ["pi-sandbox.managed=true", `pi-sandbox.repo-hash=${repoA}`],
    });

    const first = await create("agent-a1", repoA);
    const second = await create("agent-a2", repoA);

    await create("agent-b", repoB);

    await backend.removeContainer(first.id);

    expect(cli.networks.has(`pi-sandbox-${"a".repeat(12)}`)).toBe(true);

    await backend.removeContainer(second.id);

    expect(cli.networks.has(`pi-sandbox-${"a".repeat(12)}`)).toBe(false);
    expect(cli.networks.has(`pi-sandbox-${"b".repeat(12)}`)).toBe(true);
  });

  it("keeps the repository's network when asked to while the last container is replaced", async () => {
    const { cli, backend } = await readyCli();
    const repo = "a".repeat(64);
    const route = await backend.prepareProxyRoute(3128, "p".repeat(64), "image", repo);
    const created = await backend.createContainer({
      ...spec,
      name: "agent-a",
      labels: { "pi-sandbox.repo-hash": repo },
      network: route.network,
    });

    await backend.removeContainer(created.id, { keepNetwork: true });

    expect(cli.networks.has(`pi-sandbox-${"a".repeat(12)}`)).toBe(true);
  });

  it("prunes managed networks of repositories outside the keep set", async () => {
    const { cli, backend } = await readyCli();
    const repoA = "a".repeat(64);
    const repoB = "b".repeat(64);

    await backend.prepareProxyRoute(3128, "p".repeat(64), "image");

    await backend.prepareProxyRoute(3128, "p".repeat(64), "image", repoA);

    await backend.prepareProxyRoute(3128, "p".repeat(64), "image", repoB);

    cli.networks.set("pi-sandbox-foreign", { internal: true, labels: [] });

    expect(await backend.pruneNetworks([repoA])).toEqual(["pi-sandbox", `pi-sandbox-${"b".repeat(12)}`]);
    expect([...cli.networks.keys()].sort()).toEqual([`pi-sandbox-${"a".repeat(12)}`, "pi-sandbox-foreign"]);
  });

  it("refuses an existing pi-sandbox network that is not internal", async () => {
    const { cli, backend } = await readyCli();

    cli.networks.set("pi-sandbox", { internal: false, labels: ["pi-sandbox.managed=true"] });

    await expect(backend.prepareProxyRoute(3128, "a".repeat(64), "image")).rejects.toThrow(
      "container network pi-sandbox exists but is not internal",
    );
  });

  it("refuses an existing pi-sandbox network without the managed label", async () => {
    const { cli, backend } = await readyCli();

    cli.networks.set("pi-sandbox", { internal: true, labels: [] });

    await expect(backend.prepareProxyRoute(3128, "a".repeat(64), "image")).rejects.toThrow(
      "container network pi-sandbox exists but is not managed by pi-sandbox",
    );
  });

  it("refuses a pi-sandbox network whose inspect output cannot show it is internal", async () => {
    const inspected = JSON.stringify([{ id: "pi-sandbox", status: { gateway: "192.168.66.1" } }]);
    const runner = createFakeRunner((call) =>
      call.args.slice(0, 2).join(" ") === "network inspect" ? { code: 0, stdout: inspected } : undefined,
    ).runner;
    const backend = createAppleBackend({ runner });

    await expect(backend.prepareProxyRoute(3128, "a".repeat(64), "image")).rejects.toThrow(
      "container network pi-sandbox cannot be verified as internal",
    );
  });

  it("labels the volumes it creates as managed", async () => {
    const { cli, backend } = await readyCli();

    await backend.ensureVolume("pi-sandbox-cache-x");

    expect(cli.volumeLabels.get("pi-sandbox-cache-x")).toEqual(["pi-sandbox.managed=true"]);
  });

  it("passes the stop timeout through", async () => {
    const { cli, backend } = await readyCli();
    const { id } = await backend.createContainer(spec);

    await backend.startContainer(id);

    await backend.stopContainer(id, 10);

    expect(parse(lastCall(cli.calls, "stop").slice(1))).toEqual({
      pairs: ["--time 10"],
      switches: [],
      positional: [id],
    });
    expect(cli.containers.get(id)?.status).toBe("stopped");
  });

  it("reports runtime and version in status", async () => {
    const { backend } = await readyCli();

    expect(await backend.status()).toEqual({
      runtime: "running",
      version: "container CLI version 0.9.0 (fake)",
    });
  });

  it("reports a missing container CLI as unavailable", async () => {
    const backend = createAppleBackend({ runner: createFakeRunner(() => undefined).runner });

    expect(await backend.detect()).toEqual({ available: false, reason: "container: command not found" });
  });

  it("reports a stopped container system with the command that starts it", async () => {
    const backend = createAppleBackend({ runner: createFakeContainerCli({ systemRunning: false }).runner });
    const detection = await backend.detect();

    expect(detection.available).toBe(false);
    expect(detection.reason).toContain("container system start");
  });

  it("names the failing subcommand when the CLI refuses", async () => {
    const backend = createAppleBackend({ runner: createFakeContainerCli().runner });

    await expect(backend.pullImage("example.test/absent:1")).rejects.toThrow(
      "container image pull: Error: example.test/absent:1 not found",
    );
  });
});
