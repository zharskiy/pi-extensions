import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Backend, createDockerEngineBackend, LABELS, resolveDockerSocket } from "../../backend/index.ts";
import { createProcessRunner } from "../../shared/index.ts";

const RELAY_IMAGE = "pi-sandbox-relay-test:alpine";

const CLIENT_IMAGE = "pi-sandbox-conformance:busybox";

const CLIENT_NAME = "pi-sandbox-relay-client";

const POLICY_HASH = "0".repeat(64);

const REPO_HASH = "f".repeat(64);

const colimaSockets = () => {
  const root = join(homedir(), ".colima");

  return existsSync(root) ? readdirSync(root).map((profile) => join(root, profile, "docker.sock")) : [];
};

const socketPath = [
  resolveDockerSocket({ env: process.env, home: homedir() }),
  ...colimaSockets(),
  "/var/run/docker.sock",
  join(homedir(), ".docker", "run", "docker.sock"),
].find((path) => existsSync(path));

const enabled = process.env.PI_SANDBOX_LIVE === "1" && socketPath !== undefined;

const buildImage = async (backend: Backend, tag: string, dockerfile: string) => {
  const context = await mkdtemp(join(tmpdir(), "pi-sandbox-relay-live-"));

  await writeFile(join(context, "Dockerfile"), dockerfile);

  await backend.buildImage(context, tag);

  await rm(context, { recursive: true, force: true });
};

const listen = () =>
  new Promise<Server>((resolve) => {
    const server = createServer((socket) => {
      socket.on("data", () => socket.end("pong from host\n"));
    });

    server.listen(0, "127.0.0.1", () => resolve(server));
  });

const portOf = (server: Server) => {
  const address = server.address();

  return typeof address === "object" && address !== null ? address.port : 0;
};

describe.skipIf(!enabled)("docker-engine egress relay (live)", () => {
  const backend = createDockerEngineBackend({
    socketPath: socketPath ?? "",
    runner: createProcessRunner(),
    home: homedir(),
  });
  const state: { server?: Server; clientId?: string; address?: string } = {};

  const run = async (script: string) => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const chunks: Buffer[] = [];

    stdout.on("data", (chunk: Buffer) => chunks.push(chunk));

    stderr.on("data", (chunk: Buffer) => chunks.push(chunk));

    const exitCode = await backend.exec(
      { containerId: state.clientId ?? "", command: ["sh", "-c", script], env: {}, workdir: "/" },
      { stdout, stderr, tty: false },
    );
    const output = Buffer.concat(chunks).toString("utf8");

    console.log(`$ ${script}\n${output}exit ${exitCode}`);

    return { output, exitCode };
  };

  beforeAll(async () => {
    await backend.pullImage("busybox:1.36");

    await buildImage(backend, CLIENT_IMAGE, 'FROM busybox:1.36\nCMD ["sleep", "3600"]\n');

    await buildImage(backend, RELAY_IMAGE, "FROM alpine:3.20\nRUN apk add --no-cache socat\n");

    state.server = await listen();

    const route = await backend.prepareProxyRoute({
      hostPort: portOf(state.server),
      repoHash: REPO_HASH,
      relay: { policyHash: POLICY_HASH, imageId: RELAY_IMAGE },
    });
    const stale = await backend.findContainers({ "pi-sandbox.relay-client": "true" });

    await Promise.all(stale.map((container) => backend.removeContainer(container.id)));

    const client = await backend.createContainer({
      name: CLIENT_NAME,
      image: CLIENT_IMAGE,
      labels: { "pi-sandbox.relay-client": "true", [LABELS.repoHash]: REPO_HASH },
      mounts: [],
      network: route.network,
      env: {},
      workdir: "/",
      readOnlyRoot: true,
      tmpfs: ["/tmp"],
      init: true,
      resources: {},
    });

    await backend.startContainer(client.id);

    state.clientId = client.id;

    state.address = route.address;
  });

  afterAll(async () => {
    const relays = await backend.findContainers({ [LABELS.relay]: "true" });

    await Promise.all(
      [state.clientId, ...relays.map((relay) => relay.id)].map((id) => id && backend.removeContainer(id)),
    );

    state.server?.close();
  });

  it("reaches the host listener through the relay address the route reports", async () => {
    const [host, port] = (state.address ?? "").split(":");
    const result = await run(`echo ping | nc -w 5 ${host} ${port}`);

    expect(result.output).toContain("pong from host");
  });

  it("cannot connect directly to 1.1.1.1:443", async () => {
    const result = await run("nc -w 3 1.1.1.1 443 </dev/null");

    expect(result.exitCode).not.toBe(0);
  });

  it("cannot resolve external names", async () => {
    const result = await run("nslookup example.com");

    expect(result.exitCode).not.toBe(0);
  });
});
