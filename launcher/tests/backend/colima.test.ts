import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createColimaBackend } from "../../backend/colima/backend.ts";
import { demultiplexer } from "../../backend/colima/exec-session.ts";
import { engineSocketPath } from "../../backend/colima/profile.ts";
import { RELAY_SCRIPT } from "../../backend/colima/relay-script.ts";
import {
  type Backend,
  type ContainerSpec,
  execCapture,
  installIdOf,
  LABELS,
  networkName,
  relayName,
  type TerminalSize,
} from "../../backend/index.ts";
import { createProcessRunner, LauncherError } from "../../shared/index.ts";
import {
  createFakeEngine,
  FAKE_NETWORK_SUBNET,
  type FakeEngine,
  type FakeEngineOptions,
} from "../support/fake-engine.ts";
import { createFakeRunner } from "../support/fake-runner.ts";

const IMAGE = "example.test/pi-sandbox:1";

const DIGEST = `sha256:${"c".repeat(64)}`;

const REPO = "e".repeat(64);

const INSTALL = installIdOf("/nonexistent");

const RELAY = relayName(INSTALL);

const NETWORK = networkName(INSTALL);

interface RouteOptions {
  image?: string;
  preamble?: string;
}

const PREAMBLE = "PI-SANDBOX t0k3n";

const routeOn = (backend: Backend, hostPort: number, options: RouteOptions = {}) =>
  backend.prepareRelay({
    hostPort,
    imageId: options.image ?? IMAGE,
    preamble: options.preamble ?? PREAMBLE,
  });

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
    | { Cmd?: string[]; Env?: string[]; Labels?: Record<string, string> }
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
  resources: { cpus: 2, memoryGiB: 4, pids: 4096 },
  capabilities: ["CHOWN"],
  autoRemove: true,
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

    expect(await routeOn(backend, 3128)).toBe(NETWORK);
    expect(relayBody(engine)?.Cmd).toEqual(["3128", "host.lima.internal", "3128", FAKE_NETWORK_SUBNET]);
  });
});

describe("colima adapter status", () => {
  it("reports the socket path and engine version in status", async () => {
    const engine = await startEngine();

    expect(await backendFor(engine).status()).toEqual({
      socket: engine.socketPath,
      profile: "pi-sandbox",
      engine: "28.3.0-fake",
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

  it("hints at the plain profile start, which leaves the docker context alone", async () => {
    const dir = await temporaryDir();
    const backend = createColimaBackend({
      home: "/nonexistent",
      stateDir: "/nonexistent",
      socketPath: join(dir, "missing.sock"),
      runner: createFakeRunner(() => undefined).runner,
    });

    const failure = await backend.listVolumes().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(LauncherError);
    expect((failure as LauncherError).hint).toBe(
      "run pi, which starts the sandbox VM with its planned shares",
    );
  });

  const hungSocket = async () => {
    const dir = await mkdtemp(join("/tmp", "psb-"));
    const socketPath = join(dir, "hung.sock");
    const server = createServer(() => undefined).listen(socketPath);

    cleanups.push(async () => {
      server.close();

      await rm(dir, { recursive: true, force: true });
    });

    return socketPath;
  };

  const hungBackend = (socketPath: string) =>
    createColimaBackend({
      home: "/nonexistent",
      stateDir: "/nonexistent",
      socketPath,
      runner: createFakeRunner(() => undefined).runner,
      timeouts: { callMs: 100, pingMs: 50, removalMs: 400 },
    });

  it("gives up on a socket that accepts but never answers, without advising a VM restart for a slow call", async () => {
    const socketPath = await hungSocket();
    const backend = hungBackend(socketPath);

    expect(await backend.detect()).toEqual({
      available: false,
      reason: `engine socket ${socketPath} did not answer GET /_ping: no answer within 0.05 s`,
    });

    const failure = (await backend.listImages().catch((error: unknown) => error)) as LauncherError;

    expect(failure.message).toBe(
      `engine socket ${socketPath} did not answer GET /images/json: no answer within 0.1 s`,
    );
    expect(failure.hint).toBe(
      "the engine may still be finishing it; run the command again later, and see ~/.colima/_lima/colima-pi-sandbox/ha.stderr.log if it keeps timing out",
    );
  });

  const halfAnswer = async (close: boolean) => {
    const dir = await mkdtemp(join("/tmp", "psb-"));
    const socketPath = join(dir, "half.sock");
    const server = createServer((connection) => {
      connection.once("data", () => {
        connection.write(
          "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n[{",
        );

        if (close) {
          connection.destroy();
        }
      });
    }).listen(socketPath);

    cleanups.push(async () => {
      server.close();

      await rm(dir, { recursive: true, force: true });
    });

    return socketPath;
  };

  it("says the engine closed a call it had begun to answer, without advising a VM start", async () => {
    const socketPath = await halfAnswer(true);
    const failure = (await hungBackend(socketPath)
      .removeNetwork()
      .catch((error: unknown) => error)) as LauncherError;

    expect(failure.message).toMatch(
      new RegExp(`^engine socket ${socketPath} closed GET /networks before its answer was complete \\(`),
    );
    expect(failure.hint).toBe(
      "the engine may still be finishing it; run the command again later, and see ~/.colima/_lima/colima-pi-sandbox/ha.stderr.log if it keeps timing out",
    );
  });

  it("gives up on an answer that stops halfway", async () => {
    const socketPath = await halfAnswer(false);
    const failure = (await hungBackend(socketPath)
      .removeNetwork()
      .catch((error: unknown) => error)) as LauncherError;

    expect(failure.message).toBe(
      `engine socket ${socketPath} did not answer GET /networks: no answer within 0.1 s`,
    );
  });

  it("waits the long removal timeout for a volume or image removal, and only the call timeout for a container", async () => {
    const socketPath = await hungSocket();
    const backend = hungBackend(socketPath);
    const removals = [
      backend.removeVolume("pi-sandbox-cache-big"),
      backend.removeImage("pi-sandbox-layer:old"),
      backend.removeContainer("abc"),
    ];
    const failures = (await Promise.all(
      removals.map((removal) => removal.then(() => undefined).catch((error: unknown) => error)),
    )) as LauncherError[];

    expect(failures.map((failure) => failure.message)).toEqual([
      `engine socket ${socketPath} did not answer DELETE /volumes/pi-sandbox-cache-big: no answer within 0.4 s`,
      `engine socket ${socketPath} did not answer DELETE /images/pi-sandbox-layer%3Aold: no answer within 0.4 s`,
      `engine socket ${socketPath} did not answer DELETE /containers/abc: no answer within 0.1 s`,
    ]);
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
          CapDrop: ["ALL"],
          CapAdd: ["CHOWN"],
          SecurityOpt: ["no-new-privileges"],
          PidsLimit: 4096,
        },
      },
    });
  });

  it("sends the configured pids, open files and shm limits and leaves the unset ones to the engine", async () => {
    const engine = await startEngine();
    const backend = backendFor(engine);

    await backend.pullImage(IMAGE);

    await backend.createContainer({
      ...baseSpec,
      resources: { pids: 8192, openFiles: 65536, shmMiB: 1024 },
    });

    const limited = engine.createdBodies.at(-1)?.body as { HostConfig: Record<string, unknown> };

    expect(limited.HostConfig).toMatchObject({
      PidsLimit: 8192,
      Ulimits: [{ Name: "nofile", Soft: 65536, Hard: 65536 }],
      ShmSize: 1024 * 1024 ** 2,
    });

    await backend.createContainer({ ...baseSpec, name: "pi-sandbox-unlimited" });

    const unset = engine.createdBodies.at(-1)?.body as { HostConfig: Record<string, unknown> };

    expect(unset.HostConfig).toMatchObject({ PidsLimit: 4096 });
    expect(unset.HostConfig).not.toHaveProperty("Ulimits");
    expect(unset.HostConfig).not.toHaveProperty("ShmSize");
  });

  it("maps engine states to summary states, passes the stop timeout and lets the engine remove a stopped container", async () => {
    const engine = await startEngine();
    const { backend, id } = await startedContainer(engine);

    expect(await backend.findContainers({ [LABELS.repoHash]: "abc" })).toEqual([
      {
        id,
        name: "pi-sandbox-abc",
        labels: { [LABELS.managed]: "true", [LABELS.install]: INSTALL, [LABELS.repoHash]: "abc" },
        state: "running",
        image: IMAGE,
      },
    ]);

    await backend.stopContainer(id, 10);

    await backend.removeContainer(id);

    expect(await backend.findContainers({})).toEqual([]);
    expect(engine.requests.find((request) => request.path.endsWith("/wait"))?.query.get("condition")).toBe(
      "removed",
    );
    expect(engine.requests.find((request) => request.path.endsWith("/stop"))?.query.get("t")).toBe("10");
  });

  it("removes a container together with its anonymous volumes", async () => {
    const engine = await startEngine();
    const backend = backendFor(engine);

    await backend.pullImage(IMAGE);

    const { id } = await backend.createContainer(baseSpec);

    await backend.removeContainer(id);

    const removal = engine.requests.find(
      (request) => request.method === "DELETE" && request.path === `/containers/${id}`,
    );

    expect(removal?.query.get("force")).toBe("true");
    expect(removal?.query.get("v")).toBe("true");
  });

  it("names a host folder the VM does not share when the engine misses the bind source", async () => {
    const host = await temporaryDir();
    const engine = await startEngine({ vmShares: ["/nowhere"] });
    const backend = backendFor(engine);
    const mounts = [{ kind: "bind" as const, source: host, target: "/work/repo", readOnly: false }];

    await backend.pullImage(IMAGE);

    await expect(backend.createContainer({ ...baseSpec, mounts })).rejects.toMatchObject({
      message: `the sandbox VM does not share ${host}`,
      hint: "run pi sandbox doctor; its vm shares line names the folders the VM lacks",
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

  it("reports a taken container name as an unexpected clash, without a hint", async () => {
    const engine = await startEngine();
    const { backend } = await startedContainer(engine);

    await expect(backend.createContainer(baseSpec)).rejects.toMatchObject({
      message: `unexpected name clash: container name ${baseSpec.name} is already in use`,
      hint: undefined,
    });
  });

  it("URL-encodes names in engine paths", async () => {
    const engine = await startEngine();
    const backend = backendFor(engine);

    await backend.removeVolume("odd name/../x");

    expect(engine.requests.at(-1)).toMatchObject({ method: "DELETE", path: "/volumes/odd%20name%2F..%2Fx" });
  });
});

const ENGINE_CERTIFICATE_HINT =
  "a proxy or CA on this network signs the registry and its CA is not declared in tls.extraCa; run pi sandbox doctor, which prints the tls.extraCa line to add";

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
    const built = await backend.buildImage(context, "pi-sandbox:dev", {
      progress: (step) => steps.push(step),
    });

    expect(steps).toEqual(["Step 1/1"]);
    expect(built.id).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(built.digest).toBe(built.id);
    expect(engine.images.get("pi-sandbox:dev")?.Id).toBe(built.id);
  });

  const failingBuild = async (output: string[], error: string) => {
    const engine = await startEngine({ failBuild: { output, error } });
    const context = await temporaryDir();

    await writeFile(join(context, "Dockerfile"), "FROM scratch\n");

    return createColimaBackend({
      home: "/nonexistent",
      stateDir: "/nonexistent",
      socketPath: engine.socketPath,
      runner: createProcessRunner(),
    })
      .buildImage(context, "pi-sandbox:failing")
      .then(
        () => undefined,
        (failure: LauncherError) => failure,
      );
  };

  it("keeps the last 30 lines of a failed build's output in its error", async () => {
    const output = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`);
    const failure = await failingBuild(
      [...output, "E: Unable to locate package openjdk-99"],
      "The command '/bin/sh -c apt-get install' returned a non-zero code: 100",
    );
    const lines = failure?.message.split("\n") ?? [];

    expect(lines[0]).toBe("engine: The command '/bin/sh -c apt-get install' returned a non-zero code: 100");
    expect(lines.slice(1)).toEqual(
      [...output.slice(11), "E: Unable to locate package openjdk-99"].map((line) => `  ${line}`),
    );
    expect(failure?.hint).toBeUndefined();
  });

  it("hints at tls.extraCa when a build step fails on a certificate", async () => {
    const failure = await failingBuild(
      [
        "Step 1/12 : FROM node:24-bookworm-slim",
        "Step 9/12 : RUN curl -fsSL https://example.test/x",
        "curl: (60) SSL certificate problem: unable to get local issuer certificate",
      ],
      "The command '/bin/sh -c curl' returned a non-zero code: 60",
    );

    expect(failure?.message).toContain("  curl: (60) SSL certificate problem");
    expect(failure?.hint).toBe(
      "a proxy or CA on this network signs the downloads; set tls.extraCa to its CA",
    );
  });

  it("hints at the engine's own trust when the base image pull of a build fails on a certificate", async () => {
    const failure = await failingBuild(
      ["Step 1/12 : FROM node:24-bookworm-slim"],
      'Get "https://registry-1.docker.io/v2/": tls: failed to verify certificate: x509: certificate signed by unknown authority',
    );

    expect(failure?.hint).toBe(ENGINE_CERTIFICATE_HINT);
  });

  it("hints at the engine's own trust when a pinned pull fails on a certificate", async () => {
    const backend = backendFor(
      await startEngine({ failPull: "x509: certificate signed by unknown authority" }),
    );
    const failure = await backend.pullImage(IMAGE, DIGEST).then(
      () => undefined,
      (error: LauncherError) => error,
    );

    expect(failure?.message).toContain("x509: certificate signed by unknown authority");
    expect(failure?.hint).toBe(ENGINE_CERTIFICATE_HINT);
  });

  it("gives no certificate hint for a failure whose output only names the CA bundle in its steps", async () => {
    const failure = await failingBuild(
      [
        "Step 6/12 : ARG NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt",
        "Step 7/12 : RUN npm install --global pi && update-ca-certificates",
        "npm error 404 Not Found - GET https://registry.npmjs.org/pi",
      ],
      "The command '/bin/sh -c npm install' returned a non-zero code: 1",
    );

    expect(failure?.hint).toBeUndefined();
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
    await backend.buildImage(context, "pi-sandbox:proxied", {
      args: { HTTPS_PROXY: "http://proxy.example.com:8080" },
    });

    const builds = engine.requests.filter((request) => request.path === "/build");

    expect(builds.map((request) => request.query.get("buildargs"))).toEqual([
      null,
      JSON.stringify({ HTTPS_PROXY: "http://proxy.example.com:8080" }),
    ]);
  });

  it("sends networkmode none only for an offline build", async () => {
    const engine = await startEngine();
    const context = await temporaryDir();

    await writeFile(join(context, "Dockerfile"), "FROM scratch\n");

    const backend = createColimaBackend({
      home: "/nonexistent",
      stateDir: "/nonexistent",
      socketPath: engine.socketPath,
      runner: createProcessRunner(),
    });

    await backend.buildImage(context, "pi-sandbox:online");
    await backend.buildImage(context, "pi-sandbox:offline", { offline: true });

    const builds = engine.requests.filter((request) => request.path === "/build");

    expect(builds.map((request) => request.query.get("networkmode"))).toEqual([null, "none"]);
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

describe("colima exec stream frames", () => {
  it("splits a chunk of 10 000 tiny frames into stdout and stderr without deep recursion", () => {
    const frame = (stream: number, text: string) =>
      Buffer.concat([Buffer.from([stream, 0, 0, 0, 0, 0, 0, text.length]), Buffer.from(text)]);
    const chunk = Buffer.concat(
      Array.from({ length: 10_000 }, (_, index) => frame(index % 2 === 0 ? 1 : 2, "x")),
    );
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const written = { stdout: 0, stderr: 0 };
    const deliver = demultiplexer({ stdout, stderr }, (target, data) => {
      written[target === stderr ? "stderr" : "stdout"] += data.length;
    });

    deliver(chunk.subarray(0, 5));

    deliver(chunk.subarray(5));

    expect(written).toEqual({ stdout: 5000, stderr: 5000 });
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

  it("sends an empty exec variable as NAME= so it overrides the container's value", async () => {
    const seen: string[][] = [];
    const engine = await startEngine({
      exec: (context) => {
        seen.push(context.env);

        return 0;
      },
    });
    const { backend, id } = await startedContainer(engine);
    const stdout = collected();
    const stderr = collected();

    await backend.exec(
      { containerId: id, command: ["sh"], env: { PATH: "/bin", LD_PRELOAD: "" }, workdir: "/", user: "0" },
      { stdout: stdout.stream, stderr: stderr.stream, tty: false },
    );

    expect(seen).toEqual([["PATH=/bin", "LD_PRELOAD="]]);
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

  it("ends the session quietly when the stream it writes to has gone, and leaves no listener behind", async () => {
    const engine = await startEngine({
      exec: (context) => {
        context.write("first");

        context.write("warning", "stderr");

        return 3;
      },
    });
    const { backend, id } = await startedContainer(engine);
    const gone = new Writable({
      write: (_chunk, _encoding, done) => done(Object.assign(new Error("write EPIPE"), { code: "EPIPE" })),
    });
    const stderr = collected();

    const exitCode = await backend.exec(
      { containerId: id, command: ["sh"], env: {}, workdir: "/" },
      { stdout: gone, stderr: stderr.stream, tty: false },
    );

    expect(exitCode).toBe(3);
    expect(gone.listenerCount("error")).toBe(0);
    expect(stderr.stream.listenerCount("error")).toBe(0);
  });

  it("fails the session on any other error of an output stream", async () => {
    const engine = await startEngine({
      exec: (context) => {
        context.write("first");

        return 0;
      },
    });
    const { backend, id } = await startedContainer(engine);
    const failing = new Writable({
      write: (_chunk, _encoding, done) => done(Object.assign(new Error("disk full"), { code: "ENOSPC" })),
    });

    await expect(
      backend.exec(
        { containerId: id, command: ["sh"], env: {}, workdir: "/" },
        { stdout: failing, stderr: collected().stream, tty: false },
      ),
    ).rejects.toThrow("disk full");
  });

  it("drops the session when a capture runs past its timeout, and leaves other captures untimed", async () => {
    const hung: { release: (code: number) => void } = { release: () => undefined };
    const engine = await startEngine({
      exec: (context) =>
        context.command.includes("hang")
          ? new Promise<number>((resolve) => {
              hung.release = resolve;
            })
          : 0,
    });
    const { backend, id } = await startedContainer(engine);
    const spec = (word: string) => ({ containerId: id, command: ["sh", "-c", word], env: {}, workdir: "/" });

    await expect(execCapture(backend, spec("hang"), "", 50)).rejects.toThrow(
      "the command in the sandbox did not finish within 50 ms",
    );
    expect(await execCapture(backend, spec("true"))).toEqual({ code: 0, stdout: "", stderr: "" });

    hung.release(0);
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
    await expect(refused).rejects.toThrow("volume pi-sandbox-agent-u1 is in use by a sandbox container");
    await expect(refused).rejects.toMatchObject({
      hint: "end the pi sessions that use it, then run the command again",
    });
  });
});

describe("colima objects of older builds", () => {
  const MANAGED = { [LABELS.managed]: "true" };

  const plantContainer = (
    engine: Awaited<ReturnType<typeof startEngine>>,
    name: string,
    labels: Record<string, string>,
    state: "exited" | "running" = "exited",
  ) => {
    engine.containers.set(name, {
      Id: name,
      Name: name,
      State: state,
      body: { Image: IMAGE, Labels: labels },
      logs: [],
      exitCode: 0,
    });
  };

  it("lists only the managed pi-sandbox objects with no install label, and removes such a network by name", async () => {
    const engine = await startEngine();
    const backend = backendFor(engine);

    await backend.ensureVolume("pi-sandbox-agent-current");

    engine.volumes.set("pi-sandbox-agent-old", Buffer.alloc(0));

    engine.volumeLabels.set("pi-sandbox-agent-old", MANAGED);

    engine.volumes.set("pi-sandbox-agent-unmanaged", Buffer.alloc(0));

    engine.volumeLabels.set("pi-sandbox-agent-unmanaged", {});

    engine.volumes.set("project-data", Buffer.alloc(0));

    engine.volumeLabels.set("project-data", MANAGED);

    engine.networks.set("pi-sandbox-network-old", {
      body: { Name: "pi-sandbox-network-old", Labels: MANAGED },
      connected: [],
    });

    engine.networks.set("pi-sandbox-network-unmanaged", {
      body: { Name: "pi-sandbox-network-unmanaged", Labels: {} },
      connected: [],
    });

    plantContainer(engine, "pi-sandbox-agent-old", MANAGED);

    plantContainer(engine, "pi-sandbox-agent-now", { ...MANAGED, [LABELS.install]: INSTALL });

    plantContainer(engine, "pi-sandbox-agent-unmanaged", {});

    plantContainer(engine, "project-app", MANAGED);

    await backend.prepareNetwork();

    const listed = await backend.listOlderBuildObjects();

    expect(listed.volumes).toEqual(["pi-sandbox-agent-old"]);
    expect(listed.networks).toEqual(["pi-sandbox-network-old"]);
    expect(listed.containers.map((container) => container.name)).toEqual(["pi-sandbox-agent-old"]);
    await expect(backend.removeNamedNetwork("pi-sandbox-network-old")).resolves.toBe(true);
    expect(engine.networks.has("pi-sandbox-network-old")).toBe(false);
    expect(engine.networks.has(NETWORK)).toBe(true);
  });

  it("resolves false when the engine refuses to remove a network a running container uses", async () => {
    const engine = await startEngine();
    const backend = backendFor(engine);

    plantContainer(engine, "pi-sandbox-agent-busy", MANAGED, "running");

    engine.networks.set("pi-sandbox-network-busy", {
      body: { Name: "pi-sandbox-network-busy", Labels: MANAGED },
      connected: [{ container: "pi-sandbox-agent-busy", address: "10.0.0.2" }],
    });

    await expect(backend.removeNamedNetwork("pi-sandbox-network-busy")).resolves.toBe(false);
    expect(engine.networks.has("pi-sandbox-network-busy")).toBe(true);
  });
});

describe("colima sandbox network", () => {
  it("creates the sandbox network with no repository label and keeps it on a second call", async () => {
    const engine = await startEngine();
    const backend = backendFor(engine);

    expect(await backend.prepareNetwork()).toBe(NETWORK);
    expect(await backend.prepareNetwork()).toBe(NETWORK);
    expect(engine.networks.get(NETWORK)?.body).toEqual({
      Name: NETWORK,
      Driver: "bridge",
      Internal: true,
      EnableIPv6: false,
      CheckDuplicate: true,
      Options: { "com.docker.network.bridge.gateway_mode_ipv4": "isolated" },
      Labels: { [LABELS.managed]: "true", [LABELS.install]: INSTALL },
    });
  });

  it("gives the pod its services alias when it creates it on the sandbox network", async () => {
    const engine = await startEngine();
    const backend = backendFor(engine);

    await backend.pullImage(IMAGE);

    await backend.prepareNetwork();

    const pod = await backend.createContainer({
      ...baseSpec,
      network: { kind: "internal", name: NETWORK, alias: "pi-sandbox-services" },
    });

    expect(engine.networks.get(NETWORK)?.connected).toEqual([
      expect.objectContaining({ container: pod.id, aliases: ["pi-sandbox-services"] }),
    ]);
  });

  it("refuses a sandbox network the launcher did not make", async () => {
    const engine = await startEngine();
    const backend = backendFor(engine);

    engine.networks.set(NETWORK, { body: { Name: NETWORK, Internal: true }, connected: [] });

    await expect(backend.prepareNetwork()).rejects.toThrow(
      `network ${NETWORK} exists but is not managed by pi-sandbox`,
    );
  });

  it("removes a network once nothing is on it, and tolerates a missing one", async () => {
    const engine = await startEngine();
    const backend = backendFor(engine);

    await backend.pullImage(IMAGE);

    await backend.prepareNetwork();

    const pod = await backend.createContainer({ ...baseSpec, network: { kind: "internal", name: NETWORK } });

    await backend.startContainer(pod.id);

    await expect(backend.removeNetwork()).resolves.toBe(false);

    expect(engine.networks.has(NETWORK)).toBe(true);

    await backend.stopContainer(pod.id, 1);

    await backend.removeContainer(pod.id);

    await expect(backend.removeNetwork()).resolves.toBe(true);

    expect(engine.networks.has(NETWORK)).toBe(false);

    await expect(backend.removeNetwork()).resolves.toBe(false);
  });
});

describe("colima egress relay", () => {
  const readyBackend = async () => {
    const engine = await startEngine();
    const backend = backendFor(engine);

    await backend.pullImage(IMAGE);

    return { engine, backend };
  };

  it("creates the sandbox network and one running relay on it under the proxy alias, with no repository label", async () => {
    const { engine, backend } = await readyBackend();
    const route = await routeOn(backend, 3128);
    const relay = relayOf(engine);

    expect(route).toBe(NETWORK);
    expect(engine.networks.get(NETWORK)?.body).toEqual({
      Name: NETWORK,
      Driver: "bridge",
      Internal: true,
      EnableIPv6: false,
      CheckDuplicate: true,
      Options: { "com.docker.network.bridge.gateway_mode_ipv4": "isolated" },
      Labels: { [LABELS.managed]: "true", [LABELS.install]: INSTALL },
    });
    expect(engine.networks.get(NETWORK)?.connected).toEqual([
      expect.objectContaining({ container: relay?.Id, aliases: ["pi-sandbox-proxy"] }),
    ]);
    expect(relay?.State).toBe("running");
    expect(relayBody(engine)).toMatchObject({
      Image: IMAGE,
      Labels: {
        [LABELS.managed]: "true",
        [LABELS.install]: INSTALL,
        [LABELS.role]: "relay",
        [LABELS.relayInputs]: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
      Entrypoint: ["node", "-e", RELAY_SCRIPT],
      Env: [`PI_SANDBOX_RELAY_PREAMBLE=${PREAMBLE}`],
      HostConfig: {
        NetworkMode: "bridge",
        AutoRemove: true,
        ReadonlyRootfs: true,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges"],
        PidsLimit: 1024,
      },
    });
    expect(relayBody(engine)?.Labels).not.toHaveProperty([LABELS.repoHash]);
    expect(relayBody(engine)).not.toHaveProperty("HostConfig.CapAdd");
  });

  it("reuses a running relay for the same host port", async () => {
    const { engine, backend } = await readyBackend();

    await routeOn(backend, 3128);

    const first = relayOf(engine)?.Id;

    await routeOn(backend, 3128);

    expect(relayOf(engine)?.Id).toBe(first);
    expect(await backend.findContainers({ [LABELS.role]: "relay" })).toHaveLength(1);
  });

  it("recreates the relay under the same name and alias when the proxy port changes, while a sandbox runs", async () => {
    const { engine, backend } = await readyBackend();
    const route = await routeOn(backend, 3128);
    const sandbox = await backend.createContainer({
      ...baseSpec,
      name: "agent",
      labels: { [LABELS.managed]: "true", [LABELS.repoHash]: REPO },
      network: { kind: "internal", name: route },
    });

    await backend.startContainer(sandbox.id);

    const first = relayOf(engine)?.Id;
    const again = await routeOn(backend, 4000);

    expect(relayOf(engine)?.Id).not.toBe(first);
    expect(again).toBe(route);
    expect(relayBody(engine)?.Cmd).toEqual(["3128", "host.lima.internal", "4000", FAKE_NETWORK_SUBNET]);
    expect(engine.networks.get(NETWORK)?.connected).toContainEqual(
      expect.objectContaining({ container: relayOf(engine)?.Id, aliases: ["pi-sandbox-proxy"] }),
    );
    expect(engine.containers.get(sandbox.id)?.State).toBe("running");
  });

  it("replaces the relay when the preamble changes and keeps it when nothing changes", async () => {
    const { engine, backend } = await readyBackend();

    await routeOn(backend, 3128);

    const first = relayOf(engine)?.Id;
    const inputs = relayBody(engine)?.Labels?.[LABELS.relayInputs];

    await routeOn(backend, 3128, { preamble: "PI-SANDBOX other" });

    expect(relayOf(engine)?.Id).not.toBe(first);
    expect(relayBody(engine)?.Labels?.[LABELS.relayInputs]).not.toBe(inputs);
    expect(relayBody(engine)?.Env).toEqual(["PI_SANDBOX_RELAY_PREAMBLE=PI-SANDBOX other"]);
  });

  it("replaces the relay when the network's subnet changes and hands it the new subnet", async () => {
    const { engine, backend } = await readyBackend();

    await routeOn(backend, 3128);

    const first = relayOf(engine)?.Id;
    const inputs = relayBody(engine)?.Labels?.[LABELS.relayInputs];
    const network = engine.networks.get(NETWORK);

    if (network !== undefined) {
      network.body.IPAM = { Config: [{ Subnet: "10.90.0.0/24" }] };
    }

    await routeOn(backend, 3128);

    expect(relayOf(engine)?.Id).not.toBe(first);
    expect(relayBody(engine)?.Labels?.[LABELS.relayInputs]).not.toBe(inputs);
    expect(relayBody(engine)?.Cmd).toEqual(["3128", "host.lima.internal", "3128", "10.90.0.0/24"]);
  });

  it("refuses a sandbox network without an IPv4 subnet and creates no relay", async () => {
    const { engine, backend } = await readyBackend();

    engine.networks.set(NETWORK, {
      body: {
        Name: NETWORK,
        Internal: true,
        Labels: { [LABELS.managed]: "true", [LABELS.install]: INSTALL },
        Options: { "com.docker.network.bridge.gateway_mode_ipv4": "isolated" },
        IPAM: { Config: [{ Subnet: "fd00::/64" }] },
      },
      connected: [],
    });

    const failure = (await routeOn(backend, 3128).catch((error: unknown) => error)) as LauncherError;

    expect(failure).toBeInstanceOf(LauncherError);
    expect(failure.message).toBe(
      `network ${NETWORK} has no IPv4 subnet, so the relay cannot tell the sandbox containers from other clients`,
    );
    expect(relayOf(engine)).toBeUndefined();
  });

  it("refuses to create the network on an engine older than 28", async () => {
    const engine = await startEngine({ engineVersion: "27.5.1" });
    const backend = backendFor(engine);

    await backend.pullImage(IMAGE);

    const refused = routeOn(backend, 3128);

    await expect(refused).rejects.toThrow(
      "the sandbox VM runs Docker Engine 27.5.1, and the sandbox network needs 28.0 or later to keep the VM itself off it",
    );
    await expect(refused).rejects.toMatchObject({
      hint: "update colima, then delete and recreate the sandbox VM so it gets a newer engine",
    });
    expect(engine.networks.has(NETWORK)).toBe(false);
  });

  it("replaces a relay that stays created or is no longer on the sandbox network", async () => {
    const { engine, backend } = await readyBackend();

    await routeOn(backend, 3128);

    const created = relayOf(engine);

    if (created !== undefined) {
      created.State = "created";
    }

    await routeOn(backend, 3128);

    const restarted = relayOf(engine);

    expect(restarted?.Id).not.toBe(created?.Id);
    expect(restarted?.State).toBe("running");

    const network = engine.networks.get(NETWORK);

    if (network !== undefined) {
      network.connected = [];
    }

    await routeOn(backend, 3128);

    expect(relayOf(engine)?.Id).not.toBe(restarted?.Id);
    expect(engine.networks.get(NETWORK)?.connected).toEqual([
      expect.objectContaining({ container: relayOf(engine)?.Id, aliases: ["pi-sandbox-proxy"] }),
    ]);
  });

  const quickBackend = (engine: FakeEngine) =>
    createColimaBackend({
      home: "/nonexistent",
      stateDir: "/nonexistent",
      socketPath: engine.socketPath,
      runner: createFakeRunner(() => undefined).runner,
      timeouts: { callMs: 200, pingMs: 200, removalMs: 1000 },
    });

  it("waits for the engine to finish removing the old relay before it creates the replacement", async () => {
    const engine = await startEngine({ lingeringRemovals: 5 });
    const backend = quickBackend(engine);

    await backend.pullImage(IMAGE);

    await routeOn(backend, 3128);

    const old = relayOf(engine)?.Id;

    await routeOn(backend, 4000);

    expect(relayOf(engine)?.Id).not.toBe(old);
    expect(relayOf(engine)?.State).toBe("running");
    expect(relayBody(engine)?.Cmd).toEqual(["3128", "host.lima.internal", "4000", FAKE_NETWORK_SUBNET]);
  });

  it("keeps the engine's own error when it refuses to remove the old relay", async () => {
    const engine = await startEngine({ failContainerRemoval: "driver failed removing container" });
    const backend = quickBackend(engine);

    await backend.pullImage(IMAGE);

    await routeOn(backend, 3128);

    await expect(routeOn(backend, 4000)).rejects.toThrow(
      /^engine: DELETE \/containers\/[0-9a-f]+ failed \(500\): driver failed removing container$/,
    );
  });

  it("says the old relay is still being removed when the engine never finishes removing it", async () => {
    const engine = await startEngine({ lingeringRemovals: Number.POSITIVE_INFINITY });
    const backend = quickBackend(engine);

    await backend.pullImage(IMAGE);

    await routeOn(backend, 3128);

    await expect(routeOn(backend, 4000)).rejects.toThrow(
      `relay ${RELAY} is still being removed by the engine, so its replacement cannot be created`,
    );
  });

  it("creates no relay when the sandbox network is refused", async () => {
    const { engine, backend } = await readyBackend();

    engine.networks.set(NETWORK, { body: { Name: NETWORK, Internal: true }, connected: [] });

    await expect(routeOn(backend, 3128)).rejects.toBeInstanceOf(LauncherError);
    expect(relayOf(engine)).toBeUndefined();
  });

  it("a stopped relay goes by itself, and a route while the engine still removes it creates a fresh one at once", async () => {
    const { engine, backend } = await readyBackend();

    await routeOn(backend, 3128);

    const old = relayOf(engine)?.Id;

    await backend.stopContainer(old ?? "");

    expect(relayOf(engine)?.State).toBe("removing");

    const started = Date.now();

    await routeOn(backend, 3128);

    expect(Date.now() - started).toBeLessThan(5000);
    expect(relayOf(engine)?.Id).not.toBe(old);
    expect(relayOf(engine)?.State).toBe("running");
  });

  it("creates the relay from a pinned image pulled by digest, which has no tag", async () => {
    const engine = await startEngine();
    const backend = backendFor(engine);
    const pinned = await backend.pullImage(IMAGE, DIGEST);

    expect(engine.images.has(IMAGE)).toBe(false);
    expect(await routeOn(backend, 3128, { image: pinned.id })).toBe(NETWORK);
    expect(relayBody(engine)).toMatchObject({ Image: pinned.id });
    expect(relayOf(engine)?.State).toBe("running");
  });
});
