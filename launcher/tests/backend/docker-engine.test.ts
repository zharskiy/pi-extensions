import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDockerEngineBackend } from "../../backend/docker-engine/backend.ts";
import { type ContainerSpec, resolveDockerSocket, type TerminalSize } from "../../backend/index.ts";
import { createProcessRunner, LauncherError } from "../../shared/index.ts";
import { createFakeEngine, type FakeEngine, type FakeEngineOptions } from "../support/fake-engine.ts";
import { createFakeRunner } from "../support/fake-runner.ts";

const IMAGE = "example.test/pi-sandbox:1";

const DIGEST = `sha256:${"c".repeat(64)}`;

const POLICY = "a".repeat(64);

const OTHER_POLICY = "b".repeat(64);

const RELAY = `pi-sandbox-relay-${POLICY.slice(0, 8)}`;

const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const temporaryDir = async () => {
  const dir = await mkdtemp(join(tmpdir(), "psb-"));

  cleanups.push(() => rm(dir, { recursive: true, force: true }));

  return dir;
};

const startEngine = async (options: FakeEngineOptions = {}) => {
  const engine = await createFakeEngine({ registry: { [IMAGE]: DIGEST }, ...options });

  cleanups.push(() => engine.close());

  return engine;
};

const backendFor = (
  engine: FakeEngine,
  home = "/nonexistent-home",
  runner = createFakeRunner(() => undefined).runner,
) => createDockerEngineBackend({ socketPath: engine.socketPath, runner, home });

const relayOf = (engine: FakeEngine, name = RELAY) =>
  [...engine.containers.values()].find((container) => container.Name === name);

const relayBody = (engine: FakeEngine, name = RELAY) =>
  engine.createdBodies.filter((entry) => entry.name === name).at(-1)?.body as
    | { Cmd?: string[]; Labels?: Record<string, string> }
    | undefined;

const baseSpec: ContainerSpec = {
  name: "pi-sandbox-abc",
  image: IMAGE,
  labels: { "pi-sandbox.repo-hash": "abc" },
  mounts: [
    { kind: "bind", source: "/work/repo", target: "/work/repo", readOnly: false },
    { kind: "bind", source: "/work/repo/.git/hooks", target: "/work/repo/.git/hooks", readOnly: true },
    { kind: "volume", source: "pi-sandbox-agent-u1", target: "/home/pi/.pi/agent", readOnly: false },
  ],
  network: { kind: "none" },
  env: { TERM: "xterm-256color", PI_OFFLINE: "1" },
  workdir: "/work/repo",
  user: "501:20",
  readOnlyRoot: true,
  tmpfs: ["/tmp", "/home/pi:mode=1777"],
  init: true,
  resources: { cpus: 2, memoryGiB: 4 },
};

const collected = () => {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];

  stream.on("data", (chunk: Buffer) => chunks.push(chunk));

  return { stream, text: () => Buffer.concat(chunks).toString("utf8") };
};

const startedContainer = async (engine: FakeEngine) => {
  const backend = backendFor(engine);

  await backend.pullImage(IMAGE);

  const { id } = await backend.createContainer(baseSpec);

  await backend.startContainer(id);

  return { backend, id };
};

const resizeSource = () => {
  const listeners = new Set<(size: TerminalSize) => void>();

  const onResize = (listener: (size: TerminalSize) => void) => {
    listeners.add(listener);

    return () => {
      listeners.delete(listener);
    };
  };

  const emit = (size: TerminalSize) => {
    listeners.forEach((listener) => {
      listener(size);
    });
  };

  return { onResize, emit, listeners };
};

const agentRunner = () =>
  createFakeRunner((call) =>
    call.file === "colima" && call.args.join(" ") === "ssh --profile pi-sandbox -- printenv SSH_AUTH_SOCK"
      ? { stdout: "/run/host-services/ssh-auth.sock\n" }
      : undefined,
  ).runner;

describe("resolveDockerSocket", () => {
  const home = "/Users/dev";
  const existing = (paths: string[]) => (path: string) => paths.includes(path);

  it("prefers a unix DOCKER_HOST", () => {
    const socket = resolveDockerSocket({
      env: { DOCKER_HOST: "unix:///run/custom.sock" },
      home,
      exists: existing([]),
    });

    expect(socket).toBe("/run/custom.sock");
  });

  it("ignores a non-unix DOCKER_HOST and prefers the pi-sandbox colima profile", () => {
    const sockets = ["/Users/dev/.colima/pi-sandbox/docker.sock", "/Users/dev/.colima/default/docker.sock"];

    expect(
      resolveDockerSocket({ env: { DOCKER_HOST: "tcp://1.2.3.4:2375" }, home, exists: existing(sockets) }),
    ).toBe("/Users/dev/.colima/pi-sandbox/docker.sock");
  });

  it("falls back to the default colima profile, then the system socket", () => {
    const defaultProfile = ["/Users/dev/.colima/default/docker.sock"];

    expect(resolveDockerSocket({ env: {}, home, exists: existing(defaultProfile) })).toBe(defaultProfile[0]);
    expect(resolveDockerSocket({ env: {}, home, exists: existing([]) })).toBe("/var/run/docker.sock");
  });
});

describe("docker-engine adapter on a colima socket", () => {
  const colimaEngine = async () => {
    const home = await temporaryDir();
    const engine = await startEngine({ socketPath: join(home, ".colima", "pi-sandbox", "docker.sock") });

    return { home, engine };
  };

  it("declares ssh-agent support and relays the guest to host.lima.internal", async () => {
    const { home, engine } = await colimaEngine();
    const backend = backendFor(engine, home);

    await backend.pullImage(IMAGE);

    expect(backend.capabilities).toEqual({ singleFileMount: true, sshAgent: true, internalNetwork: true });
    expect(await backend.prepareProxyRoute(3128, POLICY, IMAGE)).toEqual({
      network: { kind: "internal", name: "pi-sandbox" },
      address: "10.89.0.2:3128",
    });
    expect(relayBody(engine)?.Cmd).toEqual(["TCP-LISTEN:3128,fork,reuseaddr", "TCP:host.lima.internal:3128"]);
  });

  it("bind-mounts the VM ssh-agent socket at the guest path the spec names", async () => {
    const { home, engine } = await colimaEngine();
    const backend = backendFor(engine, home, agentRunner());

    await backend.pullImage(IMAGE);

    await backend.createContainer({ ...baseSpec, sshAgent: { guestSocket: "/run/agent.sock" } });

    const body = engine.createdBodies.at(-1)?.body as { Env: string[]; HostConfig: { Binds: string[] } };

    expect(body.HostConfig.Binds).toContain("/run/host-services/ssh-auth.sock:/run/agent.sock");
    expect(body.Env).toContain("SSH_AUTH_SOCK=/run/agent.sock");
  });

  it("refuses an ssh-agent spec when the VM has no agent socket", async () => {
    const { home, engine } = await colimaEngine();
    const backend = backendFor(engine, home);

    await backend.pullImage(IMAGE);

    await expect(
      backend.createContainer({ ...baseSpec, sshAgent: { guestSocket: "/run/agent.sock" } }),
    ).rejects.toThrow(/ssh agent/);
    expect(engine.createdBodies).toEqual([]);
  });

  it("mounts no agent socket when the spec does not ask for one", async () => {
    const { home, engine } = await colimaEngine();
    const backend = backendFor(engine, home, agentRunner());

    await backend.pullImage(IMAGE);

    await backend.createContainer(baseSpec);

    const body = engine.createdBodies.at(-1)?.body as { Env: string[]; HostConfig: { Binds: string[] } };

    expect(body.HostConfig.Binds.some((bind) => bind.includes("ssh-auth"))).toBe(false);
    expect(body.Env.some((entry) => entry.startsWith("SSH_AUTH_SOCK="))).toBe(false);
  });
});

describe("docker-engine adapter on another engine socket", () => {
  it("declares no ssh-agent and relays the guest to host.docker.internal", async () => {
    const engine = await startEngine();
    const backend = backendFor(engine);

    await backend.pullImage(IMAGE);

    await backend.prepareProxyRoute(8080, POLICY, IMAGE);

    expect(backend.capabilities.sshAgent).toBe(false);
    expect(relayBody(engine)?.Cmd).toEqual([
      "TCP-LISTEN:3128,fork,reuseaddr",
      "TCP:host.docker.internal:8080",
    ]);
  });

  it("reports the socket path and engine version in status", async () => {
    const engine = await startEngine();

    expect(await backendFor(engine).status()).toEqual({
      socket: engine.socketPath,
      profile: "none",
      engine: "27.0.0-fake",
      api: "1.47",
      platform: "linux/arm64",
    });
  });

  it("reports an unreachable socket as unavailable with the path", async () => {
    const dir = await temporaryDir();
    const socketPath = join(dir, "missing.sock");
    const backend = createDockerEngineBackend({
      socketPath,
      runner: createFakeRunner(() => undefined).runner,
      home: dir,
    });

    const detection = await backend.detect();

    expect(detection.available).toBe(false);
    expect(detection.reason).toContain(socketPath);
  });
});

describe("docker-engine container translation", () => {
  it("translates the container spec into the engine create body", async () => {
    const engine = await startEngine();
    const backend = backendFor(engine);

    await backend.pullImage(IMAGE);

    await backend.createContainer({ ...baseSpec, network: { kind: "internal", name: "pi-sandbox-net" } });

    expect(engine.createdBodies).toEqual([
      {
        name: "pi-sandbox-abc",
        body: {
          Image: IMAGE,
          Labels: { "pi-sandbox.repo-hash": "abc" },
          Env: ["TERM=xterm-256color", "PI_OFFLINE=1"],
          WorkingDir: "/work/repo",
          User: "501:20",
          HostConfig: {
            Binds: ["/work/repo:/work/repo", "/work/repo/.git/hooks:/work/repo/.git/hooks:ro"],
            Mounts: [
              {
                Type: "volume",
                Source: "pi-sandbox-agent-u1",
                Target: "/home/pi/.pi/agent",
                ReadOnly: false,
              },
            ],
            NetworkMode: "pi-sandbox-net",
            ReadonlyRootfs: true,
            Tmpfs: { "/tmp": "", "/home/pi": "mode=1777" },
            Init: true,
            NanoCpus: 2_000_000_000,
            Memory: 4 * 1024 ** 3,
          },
        },
      },
    ]);
  });

  it("maps engine states to summary states and passes the stop timeout", async () => {
    const engine = await startEngine();
    const { backend, id } = await startedContainer(engine);

    expect(await backend.findContainers({ "pi-sandbox.repo-hash": "abc" })).toEqual([
      {
        id,
        name: "pi-sandbox-abc",
        labels: { "pi-sandbox.repo-hash": "abc" },
        state: "running",
        image: IMAGE,
      },
    ]);

    await backend.stopContainer(id, 10);

    expect((await backend.findContainers({}))[0]?.state).toBe("stopped");
    expect(engine.requests.find((request) => request.path.endsWith("/stop"))?.query.get("t")).toBe("10");
  });

  it("URL-encodes names in engine paths", async () => {
    const engine = await startEngine();
    const backend = backendFor(engine);

    await backend.removeVolume("odd name/../x");

    expect(engine.requests.at(-1)).toMatchObject({ method: "DELETE", path: "/volumes/odd%20name%2F..%2Fx" });
  });
});

describe("docker-engine images", () => {
  it("names the reference when the registry refuses the pull", async () => {
    const backend = backendFor(await startEngine());

    await expect(backend.pullImage("example.test/unknown:2")).rejects.toThrow(/example\.test\/unknown:2/);
  });

  it("pulls a pinned image by repository and digest and returns its image id", async () => {
    const engine = await startEngine();
    const backend = backendFor(engine);
    const pulled = await backend.pullImage(IMAGE, DIGEST);
    const pull = engine.requests.find((request) => request.path === "/images/create");

    expect(pull?.query.get("fromImage")).toBe("example.test/pi-sandbox");
    expect(pull?.query.get("tag")).toBe(DIGEST);
    expect(pulled.digest).toBe(DIGEST);
    expect(pulled.id).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(pulled.id).not.toBe(DIGEST);
    expect(engine.images.has(IMAGE)).toBe(false);

    await backend.createContainer({ ...baseSpec, image: pulled.id });

    expect(engine.createdBodies.at(-1)?.body).toMatchObject({ Image: pulled.id });
  });

  it("refuses a pinned digest the registry does not have", async () => {
    const backend = backendFor(await startEngine());

    await expect(backend.pullImage(IMAGE, `sha256:${"0".repeat(64)}`)).rejects.toBeInstanceOf(LauncherError);
  });

  it("does not pull again when the pinned image is present", async () => {
    const engine = await startEngine();
    const backend = backendFor(engine);
    const first = await backend.pullImage(IMAGE, DIGEST);

    expect(await backend.pullImage(IMAGE, DIGEST)).toEqual(first);
    expect(engine.requests.filter((request) => request.path === "/images/create")).toHaveLength(1);
  });

  it("resolves a local image by reference or id", async () => {
    const backend = backendFor(await startEngine());
    const pulled = await backend.pullImage(IMAGE);

    expect(await backend.resolveImage(IMAGE)).toEqual(pulled);
    expect(await backend.resolveImage(pulled.id)).toEqual(pulled);
    expect(await backend.resolveImage("example.test/absent:1")).toBeUndefined();
  });

  it("builds an image from a context directory and returns its id", async () => {
    const engine = await startEngine();
    const context = await temporaryDir();

    await writeFile(join(context, "Dockerfile"), "FROM scratch\n");

    const backend = createDockerEngineBackend({
      socketPath: engine.socketPath,
      runner: createProcessRunner(),
      home: context,
    });
    const built = await backend.buildImage(context, "pi-sandbox:dev");

    expect(built.id).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(built.digest).toBe(built.id);
    expect(engine.images.get("pi-sandbox:dev")?.Id).toBe(built.id);
  });
});

describe("docker-engine exec", () => {
  it("passes stdin, raw tty output and every resize through, then unsubscribes", async () => {
    const engine = await startEngine({
      exec: async (context) => {
        context.write(`got ${(await context.input()).toString("utf8")}`);

        return 0;
      },
    });
    const { backend, id } = await startedContainer(engine);
    const stdin = new PassThrough();
    const stdout = collected();
    const stderr = collected();
    const resizes = resizeSource();

    const running = backend.exec(
      { containerId: id, command: ["pi"], env: {}, workdir: "/work/repo" },
      {
        stdin,
        stdout: stdout.stream,
        stderr: stderr.stream,
        tty: true,
        size: { columns: 100, rows: 30 },
        onResize: resizes.onResize,
      },
    );

    await vi.waitFor(() => expect(engine.resizes).toHaveLength(1));

    resizes.emit({ columns: 120, rows: 40 });

    await vi.waitFor(() => expect(engine.resizes).toHaveLength(2));

    stdin.end("ping");

    expect(await running).toBe(0);
    expect(stdout.text()).toBe("got ping");
    expect(stderr.text()).toBe("");
    expect(resizes.listeners.size).toBe(0);
    expect(engine.resizes.map(({ rows, columns }) => ({ rows, columns }))).toEqual([
      { rows: 30, columns: 100 },
      { rows: 40, columns: 120 },
    ]);
  });

  it("demultiplexes non-tty stdout and stderr frames to their own streams", async () => {
    const engine = await startEngine({
      exec: (context) => {
        context.write("first ");

        context.write("warning", "stderr");

        context.write("second");

        return 5;
      },
    });
    const { backend, id } = await startedContainer(engine);
    const stdout = collected();
    const stderr = collected();

    const exitCode = await backend.exec(
      { containerId: id, command: ["sh"], env: {}, workdir: "/" },
      { stdout: stdout.stream, stderr: stderr.stream, tty: false },
    );

    expect(exitCode).toBe(5);
    expect(stdout.text()).toBe("first second");
    expect(stderr.text()).toBe("warning");
  });

  it("refuses to exec in a stopped container", async () => {
    const engine = await startEngine();
    const { backend, id } = await startedContainer(engine);

    await backend.stopContainer(id);

    await expect(
      backend.exec(
        { containerId: id, command: ["true"], env: {}, workdir: "/" },
        { stdout: new PassThrough(), stderr: new PassThrough(), tty: false },
      ),
    ).rejects.toThrow(/not running/);
  });
});

describe("docker-engine volumes", () => {
  it("labels the volumes it creates as managed", async () => {
    const engine = await startEngine();

    await backendFor(engine).ensureVolume("pi-sandbox-cache-x");

    expect(engine.requests.find((request) => request.path === "/volumes/create")?.body).toEqual({
      Name: "pi-sandbox-cache-x",
      Labels: { "pi-sandbox.managed": "true" },
    });
  });

  it("refuses to remove a volume that a container still mounts", async () => {
    const engine = await startEngine();
    const { backend } = await startedContainer(engine);

    const refused = backend.removeVolume("pi-sandbox-agent-u1");

    await expect(refused).rejects.toBeInstanceOf(LauncherError);
    await expect(refused).rejects.toThrow("volume pi-sandbox-agent-u1 is in use");
  });

  it("refuses to import a missing archive", async () => {
    const backend = backendFor(await startEngine());
    const dir = await temporaryDir();

    await mkdir(join(dir, "nested"));

    await expect(
      backend.importVolume("pi-sandbox-cache", join(dir, "nested", "absent.tar"), IMAGE),
    ).rejects.toThrow(/does not exist/);
  });
});

describe("docker-engine egress relay", () => {
  const readyBackend = async () => {
    const engine = await startEngine();
    const backend = backendFor(engine);

    await backend.pullImage(IMAGE);

    return { engine, backend };
  };

  it("creates a managed internal network and a running relay named after the policy", async () => {
    const { engine, backend } = await readyBackend();

    await backend.prepareProxyRoute(3128, POLICY, IMAGE);

    const relay = relayOf(engine);

    expect(engine.networks.get("pi-sandbox")?.body).toEqual({
      Name: "pi-sandbox",
      Driver: "bridge",
      Internal: true,
      Labels: { "pi-sandbox.managed": "true" },
    });
    expect(engine.networks.get("pi-sandbox")?.connected.map((entry) => entry.container)).toEqual([relay?.Id]);
    expect(relay?.State).toBe("running");
    expect(engine.createdBodies.find((entry) => entry.name === RELAY)?.body).toMatchObject({
      Image: IMAGE,
      Labels: {
        "pi-sandbox.managed": "true",
        "pi-sandbox.relay": "true",
        "pi-sandbox.relay-port": "3128",
        "pi-sandbox.proxy-policy-hash": POLICY,
        "pi-sandbox.relay-image": IMAGE,
      },
      HostConfig: { NetworkMode: "bridge", ExtraHosts: ["host.docker.internal:host-gateway"] },
    });
  });

  it("routes to the address the network reports for the relay", async () => {
    const { engine, backend } = await readyBackend();

    await backend.prepareProxyRoute(3128, POLICY, IMAGE);

    const route = await backend.prepareProxyRoute(4000, OTHER_POLICY, IMAGE);

    expect(route.address).toBe("10.89.0.3:3128");
    expect(relayOf(engine, `pi-sandbox-relay-${OTHER_POLICY.slice(0, 8)}`)?.State).toBe("running");
    expect(relayOf(engine)?.State).toBe("running");
  });

  it("reuses a running relay for the same host port and policy", async () => {
    const { engine, backend } = await readyBackend();

    await backend.prepareProxyRoute(3128, POLICY, IMAGE);

    const first = relayOf(engine)?.Id;

    await backend.prepareProxyRoute(3128, POLICY, IMAGE);

    expect(relayOf(engine)?.Id).toBe(first);
    expect(await backend.findContainers({ "pi-sandbox.relay": "true" })).toHaveLength(1);
  });

  it("recreates the relay when the host port changes", async () => {
    const { engine, backend } = await readyBackend();

    await backend.prepareProxyRoute(3128, POLICY, IMAGE);

    const first = relayOf(engine)?.Id;

    await backend.prepareProxyRoute(4000, POLICY, IMAGE);

    expect(relayOf(engine)?.Id).not.toBe(first);
    expect(relayOf(engine)?.State).toBe("running");
    expect(relayBody(engine)?.Cmd).toEqual([
      "TCP-LISTEN:3128,fork,reuseaddr",
      "TCP:host.docker.internal:4000",
    ]);
    expect(await backend.findContainers({ "pi-sandbox.relay-port": "4000" })).toHaveLength(1);
  });

  it("starts a stopped relay whose labels match instead of recreating it", async () => {
    const { engine, backend } = await readyBackend();

    await backend.prepareProxyRoute(3128, POLICY, IMAGE);

    const first = relayOf(engine)?.Id ?? "";

    await backend.stopContainer(first);

    const route = await backend.prepareProxyRoute(3128, POLICY, IMAGE);

    expect(relayOf(engine)?.Id).toBe(first);
    expect(relayOf(engine)?.State).toBe("running");
    expect(route.address).toBe("10.89.0.2:3128");
    expect(engine.createdBodies.filter((entry) => entry.name === RELAY)).toHaveLength(1);
  });

  it("reuses a relay whose port and policy match even when the image changes", async () => {
    const { engine, backend } = await readyBackend();
    const pinned = await backend.pullImage(IMAGE, DIGEST);

    await backend.prepareProxyRoute(3128, POLICY, IMAGE);

    const first = relayOf(engine)?.Id;

    await backend.prepareProxyRoute(3128, POLICY, pinned.id);

    expect(relayOf(engine)?.Id).toBe(first);
    expect(engine.createdBodies.filter((entry) => entry.name === RELAY)).toHaveLength(1);
    expect(relayBody(engine)?.Labels?.["pi-sandbox.relay-image"]).toBe(IMAGE);
  });

  it("refuses an existing pi-sandbox network that is not internal", async () => {
    const { engine, backend } = await readyBackend();

    engine.networks.set("pi-sandbox", {
      body: { Name: "pi-sandbox", Internal: false, Labels: { "pi-sandbox.managed": "true" } },
      connected: [],
    });

    await expect(backend.prepareProxyRoute(3128, POLICY, IMAGE)).rejects.toThrow(
      "network pi-sandbox exists but is not internal",
    );
    expect(relayOf(engine)).toBeUndefined();
  });

  it("refuses an existing pi-sandbox network without the managed label", async () => {
    const { engine, backend } = await readyBackend();

    engine.networks.set("pi-sandbox", { body: { Name: "pi-sandbox", Internal: true }, connected: [] });

    await expect(backend.prepareProxyRoute(3128, POLICY, IMAGE)).rejects.toBeInstanceOf(LauncherError);
    expect(relayOf(engine)).toBeUndefined();
  });

  it("creates the relay from a pinned image pulled by digest, which has no tag", async () => {
    const engine = await startEngine();
    const backend = backendFor(engine);
    const pinned = await backend.pullImage(IMAGE, DIGEST);

    expect(engine.images.has(IMAGE)).toBe(false);
    expect(await backend.prepareProxyRoute(3128, POLICY, pinned.id)).toEqual({
      network: { kind: "internal", name: "pi-sandbox" },
      address: "10.89.0.2:3128",
    });
    expect(relayBody(engine)).toMatchObject({ Image: pinned.id });
    expect(relayOf(engine)?.State).toBe("running");
  });
});
