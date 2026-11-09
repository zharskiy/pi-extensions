import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createColimaBackend } from "../../backend/colima/backend.ts";
import {
  type Backend,
  type ContainerSpec,
  engineSocketPath,
  LABELS,
  type TerminalSize,
} from "../../backend/index.ts";
import { createProcessRunner, LauncherError } from "../../shared/index.ts";
import { createFakeEngine, type FakeEngine, type FakeEngineOptions } from "../support/fake-engine.ts";
import { createFakeRunner } from "../support/fake-runner.ts";

const IMAGE = "example.test/pi-sandbox:1";

const DIGEST = `sha256:${"c".repeat(64)}`;

const REPO = "e".repeat(64);

const RELAY = `pi-sandbox-relay-${REPO.slice(0, 12)}`;

const ALIAS_ADDRESS = "pi-sandbox-proxy:3128";

const REPO_NETWORK = `pi-sandbox-${REPO.slice(0, 12)}`;

interface RouteOptions {
  image?: string;
  repo?: string;
}

const routeOn = (backend: Backend, hostPort: number, options: RouteOptions = {}) =>
  backend.prepareProxyRoute({ hostPort, repoHash: options.repo ?? REPO, imageId: options.image ?? IMAGE });

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

const backendFor = (engine: FakeEngine, runner = createFakeRunner(() => undefined).runner) =>
  createColimaBackend({
    home: "/nonexistent",
    stateDir: "/nonexistent",
    socketPath: engine.socketPath,
    runner,
  });

const relayOf = (engine: FakeEngine, name = RELAY) =>
  [...engine.containers.values()].find((container) => container.Name === name);

const relayBody = (engine: FakeEngine, name = RELAY) =>
  engine.createdBodies.filter((entry) => entry.name === name).at(-1)?.body as
    | { Cmd?: string[]; Labels?: Record<string, string> }
    | undefined;

const baseSpec: ContainerSpec = {
  name: "pi-sandbox-abc",
  image: IMAGE,
  labels: { [LABELS.repoHash]: "abc" },
  mounts: [
    { kind: "bind", source: "/work/repo", target: "/work/repo", readOnly: false },
    { kind: "bind", source: "/work/repo/.git/hooks", target: "/work/repo/.git/hooks", readOnly: true },
    { kind: "volume", source: "pi-sandbox-agent-u1", target: "/home/pi/.pi/agent", readOnly: false },
  ],
  network: { kind: "none" },
  env: { TERM: "xterm-256color", PI_OFFLINE: "1" },
  workdir: "/work/repo",
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

describe("engineSocketPath", () => {
  it("is the docker socket of the pi-sandbox colima profile under the home it is given", () => {
    expect(engineSocketPath("/Users/dev")).toBe("/Users/dev/.colima/pi-sandbox/docker.sock");
  });
});

describe("colima adapter on the colima VM", () => {
  it("relays the guest to host.lima.internal", async () => {
    const engine = await startEngine();
    const backend = backendFor(engine);

    await backend.pullImage(IMAGE);

    expect(await routeOn(backend, 3128)).toEqual({
      network: { kind: "internal", name: REPO_NETWORK },
      address: ALIAS_ADDRESS,
    });
    expect(relayBody(engine)?.Cmd).toEqual(["TCP-LISTEN:3128,fork,reuseaddr", "TCP:host.lima.internal:3128"]);
  });
});

describe("colima adapter status", () => {
  it("reports the socket path and engine version in status", async () => {
    const engine = await startEngine();

    expect(await backendFor(engine).status()).toEqual({
      socket: engine.socketPath,
      profile: "pi-sandbox",
      engine: "27.0.0-fake",
      api: "1.47",
      platform: "linux/arm64",
    });
  });

  it("reports an unreachable socket as unavailable with the path", async () => {
    const dir = await temporaryDir();
    const socketPath = join(dir, "missing.sock");
    const backend = createColimaBackend({
      home: "/nonexistent",
      stateDir: "/nonexistent",
      socketPath,
      runner: createFakeRunner(() => undefined).runner,
    });

    const detection = await backend.detect();

    expect(detection.available).toBe(false);
    expect(detection.reason).toContain(socketPath);
  });
});

describe("colima container translation", () => {
  it("translates the container spec into the engine create body", async () => {
    const engine = await startEngine();
    const backend = backendFor(engine);

    await backend.pullImage(IMAGE);

    await backend.createContainer({ ...baseSpec, network: { kind: "internal", name: "pi-sandbox-net" } });

    expect(engine.createdBodies.at(-1)).toMatchObject({
      name: "pi-sandbox-abc",
      body: {
        Env: ["TERM=xterm-256color", "PI_OFFLINE=1"],
        HostConfig: {
          Mounts: [
            { Type: "bind", Source: "/work/repo", Target: "/work/repo", ReadOnly: false },
            {
              Type: "bind",
              Source: "/work/repo/.git/hooks",
              Target: "/work/repo/.git/hooks",
              ReadOnly: true,
            },
            { Type: "volume", Source: "pi-sandbox-agent-u1", Target: "/home/pi/.pi/agent", ReadOnly: false },
          ],
          NetworkMode: "pi-sandbox-net",
          ReadonlyRootfs: true,
          AutoRemove: true,
        },
      },
    });
  });

  it("maps engine states to summary states, passes the stop timeout and lets the engine remove a stopped container", async () => {
    const engine = await startEngine();
    const { backend, id } = await startedContainer(engine);

    expect(await backend.findContainers({ [LABELS.repoHash]: "abc" })).toEqual([
      {
        id,
        name: "pi-sandbox-abc",
        labels: { [LABELS.repoHash]: "abc" },
        state: "running",
        image: IMAGE,
      },
    ]);

    await backend.stopContainer(id, 10);

    await backend.waitRemoved(id, 1000);

    await backend.removeContainer(id);

    expect(await backend.findContainers({})).toEqual([]);
    expect(engine.requests.find((request) => request.path.endsWith("/wait"))?.query.get("condition")).toBe(
      "removed",
    );
    expect(engine.requests.find((request) => request.path.endsWith("/stop"))?.query.get("t")).toBe("10");
  });

  it("names a host folder the VM does not share when the engine misses the bind source", async () => {
    const host = await temporaryDir();
    const engine = await startEngine({ vmShares: ["/nowhere"] });
    const backend = backendFor(engine);
    const mounts = [{ kind: "bind" as const, source: host, target: "/work/repo", readOnly: false }];

    await backend.pullImage(IMAGE);

    await expect(backend.createContainer({ ...baseSpec, mounts })).rejects.toMatchObject({
      message: `the sandbox VM does not share ${host}`,
      hint: "run pi sandbox doctor; its vm shares line names the command",
    });
  });

  it("keeps the engine message when the missing bind source is missing on the host too", async () => {
    const engine = await startEngine({ vmShares: ["/nowhere"] });
    const backend = backendFor(engine);

    await backend.pullImage(IMAGE);

    await expect(backend.createContainer(baseSpec)).rejects.toThrow(
      'engine: POST /containers/create failed (400): invalid mount config for type "bind": bind source path does not exist: /work/repo',
    );
  });

  it("URL-encodes names in engine paths", async () => {
    const engine = await startEngine();
    const backend = backendFor(engine);

    await backend.removeVolume("odd name/../x");

    expect(engine.requests.at(-1)).toMatchObject({ method: "DELETE", path: "/volumes/odd%20name%2F..%2Fx" });
  });
});

describe("colima images", () => {
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

  it("does not pull again when the pinned image is present", async () => {
    const engine = await startEngine();
    const backend = backendFor(engine);
    const first = await backend.pullImage(IMAGE, DIGEST);

    expect(await backend.pullImage(IMAGE, DIGEST)).toEqual(first);
    expect(engine.requests.filter((request) => request.path === "/images/create")).toHaveLength(1);
  });

  it("builds an image from a context directory, streams its steps and returns its id", async () => {
    const engine = await startEngine();
    const context = await temporaryDir();

    await writeFile(join(context, "Dockerfile"), "FROM scratch\n");

    const backend = createColimaBackend({
      home: "/nonexistent",
      stateDir: "/nonexistent",
      socketPath: engine.socketPath,
      runner: createProcessRunner(),
    });
    const steps: string[] = [];
    const built = await backend.buildImage(context, "pi-sandbox:dev", {}, (step) => steps.push(step));

    expect(steps).toEqual(["Step 1/1"]);
    expect(built.id).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(built.digest).toBe(built.id);
    expect(engine.images.get("pi-sandbox:dev")?.Id).toBe(built.id);
  });

  it("sends build args to the build and none when there are none", async () => {
    const engine = await startEngine();
    const context = await temporaryDir();

    await writeFile(join(context, "Dockerfile"), "FROM scratch\n");

    const backend = createColimaBackend({
      home: "/nonexistent",
      stateDir: "/nonexistent",
      socketPath: engine.socketPath,
      runner: createProcessRunner(),
    });

    await backend.buildImage(context, "pi-sandbox:plain");
    await backend.buildImage(context, "pi-sandbox:proxied", { HTTPS_PROXY: "http://proxy.example.com:8080" });

    const builds = engine.requests.filter((request) => request.path === "/build");

    expect(builds.map((request) => request.query.get("buildargs"))).toEqual([
      null,
      JSON.stringify({ HTTPS_PROXY: "http://proxy.example.com:8080" }),
    ]);
  });

  it("labels builds as managed, lists images with their tags and use, and removes only unused ones", async () => {
    const engine = await startEngine();
    const context = await temporaryDir();
    const backend = createColimaBackend({
      home: "/nonexistent",
      stateDir: "/nonexistent",
      socketPath: engine.socketPath,
      runner: createProcessRunner(),
    });

    await writeFile(join(context, "Dockerfile"), "FROM scratch\n");

    const used = await backend.buildImage(context, "pi-sandbox-layer:used");

    await writeFile(join(context, "Dockerfile"), "FROM scratch\nUSER pi\n");

    const idle = await backend.buildImage(context, "pi-sandbox-layer:idle");

    await backend.createContainer({ ...baseSpec, image: used.id });

    expect(await backend.listImages()).toEqual(
      expect.arrayContaining([
        {
          id: used.id,
          tags: ["pi-sandbox-layer:used"],
          labels: { [LABELS.managed]: "true" },
          inUse: true,
          created: expect.any(Number),
        },
        {
          id: idle.id,
          tags: ["pi-sandbox-layer:idle"],
          labels: { [LABELS.managed]: "true" },
          inUse: false,
          created: expect.any(Number),
        },
      ]),
    );
    expect(await backend.removeImage("pi-sandbox-layer:used")).toBe(false);
    expect(await backend.removeImage("pi-sandbox-layer:idle")).toBe(true);
    expect(await backend.removeImage("pi-sandbox-layer:idle")).toBe(false);
    expect((await backend.listImages()).map((image) => image.id)).toEqual([used.id]);
  });
});

describe("colima exec", () => {
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

  it("delivers every frame in order to a slow stdout that asks it to wait", async () => {
    const lines = Array.from({ length: 200 }, (_, index) => `line ${index}\n`);
    const engine = await startEngine({
      exec: (context) => {
        lines.forEach((line) => {
          context.write(line);
        });

        context.write("done", "stderr");

        return 0;
      },
    });
    const { backend, id } = await startedContainer(engine);
    const received: string[] = [];
    const slow = new Writable({
      highWaterMark: 16,
      write: (chunk: Buffer, _encoding, done) => {
        received.push(chunk.toString("utf8"));

        setTimeout(done, 1);
      },
    });
    const stderr = collected();

    const exitCode = await backend.exec(
      { containerId: id, command: ["sh"], env: {}, workdir: "/" },
      { stdout: slow, stderr: stderr.stream, tty: false },
    );

    await vi.waitFor(() => expect(received.join("")).toBe(lines.join("")));
    expect(exitCode).toBe(0);
    expect(stderr.text()).toBe("done");
  });

  it("refuses to exec in a container that is not running", async () => {
    const engine = await startEngine();
    const backend = backendFor(engine);

    await backend.pullImage(IMAGE);

    const { id } = await backend.createContainer(baseSpec);

    await expect(
      backend.exec(
        { containerId: id, command: ["true"], env: {}, workdir: "/" },
        { stdout: new PassThrough(), stderr: new PassThrough(), tty: false },
      ),
    ).rejects.toThrow(/not running/);
  });
});

describe("colima volumes", () => {
  it("refuses to remove a volume that a container still mounts", async () => {
    const engine = await startEngine();
    const { backend } = await startedContainer(engine);

    const refused = backend.removeVolume("pi-sandbox-agent-u1");

    await expect(refused).rejects.toBeInstanceOf(LauncherError);
    await expect(refused).rejects.toThrow("volume pi-sandbox-agent-u1 is in use");
  });
});

describe("colima egress relay", () => {
  const readyBackend = async () => {
    const engine = await startEngine();
    const backend = backendFor(engine);

    await backend.pullImage(IMAGE);

    return { engine, backend };
  };

  it("creates a managed internal network and a running relay of the repository under the proxy alias", async () => {
    const { engine, backend } = await readyBackend();
    const route = await routeOn(backend, 3128);
    const relay = relayOf(engine);

    expect(route).toEqual({ network: { kind: "internal", name: REPO_NETWORK }, address: ALIAS_ADDRESS });
    expect(engine.networks.get(REPO_NETWORK)?.body).toEqual({
      Name: REPO_NETWORK,
      Driver: "bridge",
      Internal: true,
      Labels: { [LABELS.managed]: "true", [LABELS.repoHash]: REPO },
    });
    expect(engine.networks.get(REPO_NETWORK)?.connected).toEqual([
      expect.objectContaining({ container: relay?.Id, aliases: ["pi-sandbox-proxy"] }),
    ]);
    expect(relay?.State).toBe("running");
    expect(relayBody(engine)).toMatchObject({
      Image: IMAGE,
      Labels: {
        [LABELS.managed]: "true",
        [LABELS.relay]: "true",
        [LABELS.repoHash]: REPO,
        [LABELS.relayPort]: "3128",
      },
      HostConfig: { NetworkMode: "bridge", AutoRemove: true },
    });
  });

  it("reuses a running relay for the same host port", async () => {
    const { engine, backend } = await readyBackend();

    await routeOn(backend, 3128);

    const first = relayOf(engine)?.Id;

    await routeOn(backend, 3128);

    expect(relayOf(engine)?.Id).toBe(first);
    expect(await backend.findContainers({ [LABELS.relay]: "true" })).toHaveLength(1);
  });

  it("recreates the relay under the same name and alias when the proxy port changes, while a sandbox runs", async () => {
    const { engine, backend } = await readyBackend();
    const route = await routeOn(backend, 3128);
    const sandbox = await backend.createContainer({
      ...baseSpec,
      name: "agent",
      labels: { [LABELS.managed]: "true", [LABELS.repoHash]: REPO },
      network: route.network,
    });

    await backend.startContainer(sandbox.id);

    const first = relayOf(engine)?.Id;
    const again = await routeOn(backend, 4000);

    expect(relayOf(engine)?.Id).not.toBe(first);
    expect(again).toEqual(route);
    expect(relayBody(engine)?.Cmd).toEqual(["TCP-LISTEN:3128,fork,reuseaddr", "TCP:host.lima.internal:4000"]);
    expect(engine.networks.get(REPO_NETWORK)?.connected).toContainEqual(
      expect.objectContaining({ container: relayOf(engine)?.Id, aliases: ["pi-sandbox-proxy"] }),
    );
    expect(engine.containers.get(sandbox.id)?.State).toBe("running");
  });

  it("creates no relay when the repository's network is refused", async () => {
    const { engine, backend } = await readyBackend();

    engine.networks.set(REPO_NETWORK, { body: { Name: REPO_NETWORK, Internal: true }, connected: [] });

    await expect(routeOn(backend, 3128)).rejects.toBeInstanceOf(LauncherError);
    expect(relayOf(engine)).toBeUndefined();
  });

  it("a stopped relay is gone, and the next route creates a fresh one", async () => {
    const { engine, backend } = await readyBackend();

    await routeOn(backend, 3128);

    await backend.stopContainer(relayOf(engine)?.Id ?? "");

    expect(relayOf(engine)).toBeUndefined();

    await routeOn(backend, 3128);

    expect(relayOf(engine)?.State).toBe("running");
  });

  it("creates the relay from a pinned image pulled by digest, which has no tag", async () => {
    const engine = await startEngine();
    const backend = backendFor(engine);
    const pinned = await backend.pullImage(IMAGE, DIGEST);

    expect(engine.images.has(IMAGE)).toBe(false);
    expect(await routeOn(backend, 3128, { image: pinned.id })).toEqual({
      network: { kind: "internal", name: REPO_NETWORK },
      address: ALIAS_ADDRESS,
    });
    expect(relayBody(engine)).toMatchObject({ Image: pinned.id });
    expect(relayOf(engine)?.State).toBe("running");
  });
});
