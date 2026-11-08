import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

interface FakeExecContext {
  command: string[];
  tty: boolean;
  env: string[];
  workdir: string;
  user?: string;
  input: () => Promise<Buffer>;
  write: (data: string | Buffer, stream?: OutputStream) => void;
}

type OutputStream = "stdout" | "stderr";

interface ScriptResult {
  stdout: string;
  stderr: string;
  code: number;
}

interface EngineRequestRecord {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}

interface FakeNetwork {
  body: {
    Name?: string;
    Internal?: boolean;
    Labels?: Record<string, string>;
    IPAM?: { Config: Array<{ Gateway?: string }> };
  };
  connected: Array<{ container: string; address: string }>;
}

type FakeExecHandler = (context: FakeExecContext) => Promise<number> | number;

export interface FakeEngineOptions {
  registry?: Record<string, string>;
  exec?: FakeExecHandler;
  socketPath?: string;
  operatingSystem?: string;
  bridgeGateway?: string;
}

interface FakeImage {
  Id: string;
  RepoTags: string[];
  RepoDigests: string[];
}

interface FakeMount {
  Type: string;
  Source: string;
  Target: string;
}

interface CreateBody {
  Image: string;
  Labels?: Record<string, string>;
  HostConfig?: { Mounts?: FakeMount[]; NetworkMode?: string };
}

interface FakeContainer {
  Id: string;
  Name: string;
  State: "created" | "running" | "exited";
  body: CreateBody;
}

interface FakeExec {
  containerId: string;
  body: { Cmd: string[]; Tty: boolean; Env?: string[]; WorkingDir?: string; User?: string };
  running: boolean;
  exitCode: number | null;
}

interface Route {
  method: string;
  pattern: RegExp;
  handle: (request: RouteRequest) => RouteResult | Promise<RouteResult>;
}

interface RouteRequest {
  match: RegExpMatchArray;
  query: URLSearchParams;
  body: Buffer;
}

interface RouteResult {
  status: number;
  json?: unknown;
  raw?: Buffer | string;
}

const EMPTY_TAR = Buffer.alloc(1024);

const FRAME_HEADER = 8;

const STREAM_TYPES: Record<OutputStream, number> = { stdout: 1, stderr: 2 };

const ECHO = /^echo (.*?)( >&2)?$/;

const EXIT = /^exit (\d+)$/;

const sha = (input: Buffer | string) => `sha256:${createHash("sha256").update(input).digest("hex")}`;

const notFound = (message: string): RouteResult => ({ status: 404, json: { message } });

const conflict = (message: string): RouteResult => ({ status: 409, json: { message } });

const parsed = <T>(body: Buffer) =>
  body.length === 0 ? ({} as T) : (JSON.parse(body.toString("utf8")) as T);

const normalizedPath = (url: URL) => decodeURIComponent(url.pathname).replace(/^\/v[0-9.]+\//, "/");

const frame = (data: Buffer, stream: OutputStream) => {
  const header = Buffer.alloc(FRAME_HEADER);

  header.writeUInt8(STREAM_TYPES[stream], 0);

  header.writeUInt32BE(data.length, 4);

  return Buffer.concat([header, data]);
};

const runStatement = (result: ScriptResult, statement: string): ScriptResult => {
  if (result.code >= 0) {
    return result;
  }

  const echo = ECHO.exec(statement);

  if (echo !== null && echo[2] !== undefined) {
    return { ...result, stderr: `${result.stderr}${echo[1]}\n` };
  }

  if (echo !== null) {
    return { ...result, stdout: `${result.stdout}${echo[1]}\n` };
  }

  const exit = EXIT.exec(statement);

  return exit === null ? result : { ...result, code: Number(exit[1]) };
};

export const runFakeScript = (command: string[]): ScriptResult => {
  const statements = (command.at(-1) ?? "").split(";").map((statement) => statement.trim());
  const result = statements.reduce(runStatement, { stdout: "", stderr: "", code: -1 });

  return { ...result, code: Math.max(result.code, 0) };
};

const ECHO_INPUT = "cat";

const GUEST_UID = "1000";

export const fakeUidOf = (user: string | undefined) => (user ?? GUEST_UID).split(":")[0] ?? GUEST_UID;

const defaultExec: FakeExecHandler = async (context) => {
  if (context.command.join(" ") === "id -u") {
    context.write(`${fakeUidOf(context.user)}\n`, "stdout");

    return 0;
  }

  if (context.command.at(-1) === ECHO_INPUT) {
    context.write(await context.input(), "stdout");

    return 0;
  }

  const result = runFakeScript(context.command);

  context.write(result.stdout, "stdout");

  context.write(result.stderr, "stderr");

  return result.code;
};

const referenceOf = (query: URLSearchParams) => {
  const tag = query.get("tag") ?? "latest";
  const separator = tag.startsWith("sha256:") ? "@" : ":";

  return `${query.get("fromImage")}${separator}${tag}`;
};

const repositoryOf = (reference: string) => reference.replace(/(@sha256:[0-9a-f]+|:[^/@:]*)$/, "");

export const createFakeEngine = async (options: FakeEngineOptions = {}) => {
  const directory = options.socketPath === undefined ? await mkdtemp(join(tmpdir(), "pse-")) : undefined;
  const socketPath = options.socketPath ?? join(directory ?? "", "docker.sock");
  const registry = new Map(Object.entries(options.registry ?? {}));
  const images = new Map<string, FakeImage>();
  const containers = new Map<string, FakeContainer>();
  const execs = new Map<string, FakeExec>();
  const volumes = new Map<string, Buffer>();
  const volumeLabels = new Map<string, Record<string, string>>();
  const createdBodies: Array<{ name: string; body: unknown }> = [];
  const networks = new Map<string, FakeNetwork>(
    options.bridgeGateway === undefined
      ? []
      : [
          [
            "bridge",
            {
              body: { Name: "bridge", IPAM: { Config: [{ Gateway: options.bridgeGateway }] } },
              connected: [],
            },
          ],
        ],
  );
  const requests: EngineRequestRecord[] = [];
  const resizes: Array<{ execId: string; rows: number; columns: number }> = [];
  const execHandler = options.exec ?? defaultExec;

  const findContainer = (id: string) =>
    containers.get(id) ?? [...containers.values()].find((container) => container.Name === id);

  const volumeMounts = (container: FakeContainer) =>
    (container.body.HostConfig?.Mounts ?? []).filter((mount) => mount.Type === "volume");

  const labelsMatch = (labels: Record<string, string> | undefined, filters: string[]) =>
    filters.every((filter) => {
      const [key = "", ...value] = filter.split("=");

      return labels?.[key] === value.join("=");
    });

  const findImage = (reference: string) =>
    images.get(reference) ??
    [...images.values()].find((image) => image.Id === reference || image.RepoDigests.includes(reference));

  const publishedDigest = (reference: string) => {
    const repository = repositoryOf(reference);
    const pinned = reference.slice(repository.length + 1);
    const byDigest = [...registry.entries()].find(
      ([published, digest]) => repositoryOf(published) === repository && digest === pinned,
    );

    return registry.get(reference) ?? byDigest?.[1];
  };

  const pull = ({ query }: RouteRequest): RouteResult => {
    const reference = referenceOf(query);
    const digest = publishedDigest(reference);

    if (digest === undefined) {
      return notFound(`pull access denied for ${reference}, repository does not exist`);
    }

    const pinned = `${repositoryOf(reference)}@${digest}`;

    images.set(reference, {
      Id: sha(pinned),
      RepoTags: reference === pinned ? [] : [reference],
      RepoDigests: [pinned],
    });

    return {
      status: 200,
      raw: `${JSON.stringify({ status: "Pulling" })}\n${JSON.stringify({ status: "Done" })}\n`,
    };
  };

  const build = ({ query, body }: RouteRequest): RouteResult => {
    const tag = query.get("t") ?? "unnamed";

    images.set(tag, { Id: sha(body), RepoTags: [tag], RepoDigests: [] });

    return {
      status: 200,
      raw: `${JSON.stringify({ stream: "Step 1/1" })}\n${JSON.stringify({ aux: { ID: sha(body) } })}\n`,
    };
  };

  const createContainer = ({ query, body }: RouteRequest): RouteResult => {
    const spec = parsed<CreateBody>(body);
    const name = query.get("name") ?? randomBytes(6).toString("hex");

    if (findContainer(name) !== undefined) {
      return conflict(`Conflict. The container name "/${name}" is already in use`);
    }

    if (findImage(spec.Image) === undefined) {
      return notFound(`No such image: ${spec.Image}`);
    }

    const id = randomBytes(32).toString("hex");

    createdBodies.push({ name, body: spec });

    containers.set(id, { Id: id, Name: name, State: "created", body: spec });

    const mode = spec.HostConfig?.NetworkMode ?? "";

    networks.get(mode)?.connected.push({ container: id, address: `10.89.0.${100 + containers.size}` });

    volumeMounts(containers.get(id) as FakeContainer).forEach((mount) => {
      volumes.set(mount.Source, volumes.get(mount.Source) ?? EMPTY_TAR);
    });

    return { status: 201, json: { Id: id, Warnings: [] } };
  };

  const withContainer =
    (handle: (container: FakeContainer, request: RouteRequest) => RouteResult) =>
    (request: RouteRequest): RouteResult => {
      const container = findContainer(request.match[1] ?? "");

      return container === undefined
        ? notFound(`No such container: ${request.match[1]}`)
        : handle(container, request);
    };

  const setState = (state: FakeContainer["State"]) =>
    withContainer((container) => {
      if (container.State === state) {
        return { status: 304 };
      }

      container.State = state;

      return { status: 204 };
    });

  const removeContainer = withContainer((container, { query }) => {
    if (container.State === "running" && query.get("force") !== "true") {
      return conflict("You cannot remove a running container");
    }

    containers.delete(container.Id);

    networks.forEach((network) => {
      network.connected = network.connected.filter((entry) => entry.container !== container.Id);
    });

    return { status: 204 };
  });

  const createExec = withContainer((container, { body }) => {
    if (container.State !== "running") {
      return conflict(`container ${container.Id} is not running`);
    }

    const id = randomBytes(16).toString("hex");

    execs.set(id, { containerId: container.Id, body: parsed(body), running: false, exitCode: null });

    return { status: 201, json: { Id: id } };
  });

  const inspectExec = ({ match }: RouteRequest): RouteResult => {
    const exec = execs.get(match[1] ?? "");

    return exec === undefined
      ? notFound("No such exec instance")
      : { status: 200, json: { Running: exec.running, ExitCode: exec.exitCode } };
  };

  const resizeExec = ({ match, query }: RouteRequest): RouteResult => {
    resizes.push({ execId: match[1] ?? "", rows: Number(query.get("h")), columns: Number(query.get("w")) });

    return { status: 200 };
  };

  const mountedVolume = (container: FakeContainer, path: string) =>
    volumeMounts(container).find((mount) => mount.Target === path || path === "/");

  const getArchive = withContainer((container, { query }) => {
    const mount = mountedVolume(container, query.get("path") ?? "");

    return mount === undefined
      ? notFound("Could not find the file")
      : { status: 200, raw: volumes.get(mount.Source) };
  });

  const putArchive = withContainer((container, { query, body }) => {
    const mount = mountedVolume(container, query.get("path") ?? "");

    if (mount !== undefined) {
      volumes.set(mount.Source, body);
    }

    return { status: 200 };
  });

  const volumeInUse = (name: string) =>
    [...containers.values()].some((container) =>
      volumeMounts(container).some((mount) => mount.Source === name),
    );

  const removeVolume = ({ match }: RouteRequest): RouteResult => {
    const name = match[1] ?? "";

    if (!volumes.has(name)) {
      return notFound(`get ${name}: no such volume`);
    }

    if (volumeInUse(name)) {
      return conflict(`remove ${name}: volume is in use`);
    }

    volumes.delete(name);

    volumeLabels.delete(name);

    return { status: 204 };
  };

  const inspectContainer = withContainer((container) => ({
    status: 200,
    json: {
      Id: container.Id,
      Name: `/${container.Name}`,
      State: { Running: container.State === "running", Status: container.State },
      Config: { Labels: container.body.Labels ?? {}, Image: container.body.Image },
    },
  }));

  const createNetwork = ({ body }: RouteRequest): RouteResult => {
    const spec = parsed<FakeNetwork["body"] & { Name: string }>(body);

    if (networks.has(spec.Name)) {
      return conflict(`network with name ${spec.Name} already exists`);
    }

    networks.set(spec.Name, { body: spec, connected: [] });

    return { status: 201, json: { Id: spec.Name } };
  };

  const connectNetwork = ({ match, body }: RouteRequest): RouteResult => {
    const network = networks.get(match[1] ?? "");
    const request = parsed<{ Container: string; EndpointConfig?: { IPAMConfig?: { IPv4Address?: string } } }>(
      body,
    );

    if (network === undefined) {
      return notFound(`network ${match[1]} not found`);
    }

    network.connected.push({
      container: request.Container,
      address: request.EndpointConfig?.IPAMConfig?.IPv4Address ?? `10.89.0.${network.connected.length + 2}`,
    });

    return { status: 200 };
  };

  const disconnectNetwork = ({ match, body }: RouteRequest): RouteResult => {
    const network = networks.get(match[1] ?? "");
    const request = parsed<{ Container: string }>(body);

    if (network === undefined) {
      return notFound(`network ${match[1]} not found`);
    }

    network.connected = network.connected.filter((entry) => entry.container !== request.Container);

    return { status: 200 };
  };

  const removeNetwork = ({ match }: RouteRequest): RouteResult => {
    const network = networks.get(match[1] ?? "");

    if (network === undefined) {
      return notFound(`network ${match[1]} not found`);
    }

    if (network.connected.length > 0) {
      return conflict(`network ${match[1]} has active endpoints`);
    }

    networks.delete(match[1] ?? "");

    return { status: 204 };
  };

  const networkJson = (network: FakeNetwork) => ({
    Name: network.body.Name,
    Internal: network.body.Internal ?? false,
    Labels: network.body.Labels ?? {},
    IPAM: network.body.IPAM ?? { Config: [] },
    Containers: Object.fromEntries(
      network.connected.map(({ container, address }) => [
        container,
        { Name: findContainer(container)?.Name ?? "", IPv4Address: `${address}/24` },
      ]),
    ),
  });

  const routes: Route[] = [
    { method: "GET", pattern: /^\/containers\/([^/]+)\/json$/, handle: inspectContainer },
    {
      method: "GET",
      pattern: /^\/networks\/([^/]+)$/,
      handle: ({ match }) => {
        const network = networks.get(match[1] ?? "");

        return network === undefined
          ? notFound("network not found")
          : { status: 200, json: networkJson(network) };
      },
    },
    {
      method: "GET",
      pattern: /^\/networks$/,
      handle: ({ query }) => {
        const wanted = (JSON.parse(query.get("filters") ?? "{}") as { label?: string[] }).label ?? [];
        const listed = [...networks.values()].filter((network) =>
          wanted.every((filter) => {
            const [key = "", ...value] = filter.split("=");

            return network.body.Labels?.[key] === value.join("=");
          }),
        );

        return {
          status: 200,
          json: listed.map((network) => ({ Name: network.body.Name, Labels: network.body.Labels ?? {} })),
        };
      },
    },
    { method: "POST", pattern: /^\/networks\/create$/, handle: createNetwork },
    { method: "POST", pattern: /^\/networks\/([^/]+)\/connect$/, handle: connectNetwork },
    { method: "POST", pattern: /^\/networks\/([^/]+)\/disconnect$/, handle: disconnectNetwork },
    { method: "DELETE", pattern: /^\/networks\/([^/]+)$/, handle: removeNetwork },
    { method: "GET", pattern: /^\/_ping$/, handle: () => ({ status: 200, raw: "OK" }) },
    {
      method: "GET",
      pattern: /^\/info$/,
      handle: () => ({ status: 200, json: { OperatingSystem: options.operatingSystem ?? "Docker Desktop" } }),
    },
    {
      method: "GET",
      pattern: /^\/version$/,
      handle: () => ({
        status: 200,
        json: { Version: "27.0.0-fake", ApiVersion: "1.47", Os: "linux", Arch: "arm64" },
      }),
    },
    { method: "POST", pattern: /^\/images\/create$/, handle: pull },
    { method: "POST", pattern: /^\/build$/, handle: build },
    {
      method: "GET",
      pattern: /^\/images\/json$/,
      handle: () => ({
        status: 200,
        json: [...images.values()].map(({ Id, RepoTags }) => ({ Id, RepoTags })),
      }),
    },
    {
      method: "GET",
      pattern: /^\/images\/(.+)\/json$/,
      handle: ({ match }) => {
        const image = findImage(match[1] ?? "");

        return image === undefined ? notFound(`No such image: ${match[1]}`) : { status: 200, json: image };
      },
    },
    {
      method: "GET",
      pattern: /^\/containers\/json$/,
      handle: ({ query }) => {
        const filters = parsed<{ label?: string[] }>(Buffer.from(query.get("filters") ?? "{}")).label ?? [];

        return {
          status: 200,
          json: [...containers.values()]
            .filter((container) => labelsMatch(container.body.Labels, filters))
            .map((container) => ({
              Id: container.Id,
              Names: [`/${container.Name}`],
              Labels: container.body.Labels ?? {},
              State: container.State,
              Image: container.body.Image,
              Mounts: volumeMounts(container).map((mount) => ({ Type: "volume", Name: mount.Source })),
            })),
        };
      },
    },
    { method: "POST", pattern: /^\/containers\/create$/, handle: createContainer },
    { method: "POST", pattern: /^\/containers\/([^/]+)\/start$/, handle: setState("running") },
    { method: "POST", pattern: /^\/containers\/([^/]+)\/stop$/, handle: setState("exited") },
    { method: "DELETE", pattern: /^\/containers\/([^/]+)$/, handle: removeContainer },
    { method: "POST", pattern: /^\/containers\/([^/]+)\/exec$/, handle: createExec },
    { method: "GET", pattern: /^\/exec\/([^/]+)\/json$/, handle: inspectExec },
    { method: "POST", pattern: /^\/exec\/([^/]+)\/resize$/, handle: resizeExec },
    { method: "GET", pattern: /^\/containers\/([^/]+)\/archive$/, handle: getArchive },
    { method: "PUT", pattern: /^\/containers\/([^/]+)\/archive$/, handle: putArchive },
    {
      method: "POST",
      pattern: /^\/volumes\/create$/,
      handle: ({ body }) => {
        const spec = parsed<{ Name: string; Labels?: Record<string, string> }>(body);
        const name = spec.Name;

        volumes.set(name, volumes.get(name) ?? EMPTY_TAR);

        volumeLabels.set(name, volumeLabels.get(name) ?? spec.Labels ?? {});

        return { status: 201, json: { Name: name } };
      },
    },
    {
      method: "GET",
      pattern: /^\/volumes\/([^/]+)$/,
      handle: ({ match }) =>
        volumes.has(match[1] ?? "") ? { status: 200, json: { Name: match[1] } } : notFound("no such volume"),
    },
    {
      method: "GET",
      pattern: /^\/volumes$/,
      handle: ({ query }) => {
        const wanted = parsed<{ label?: string[] }>(Buffer.from(query.get("filters") ?? "{}")).label ?? [];
        const listed = [...volumes.keys()]
          .map((name) => ({ Name: name, Labels: volumeLabels.get(name) ?? {} }))
          .filter((volume) =>
            wanted.every((filter) => {
              const [key = "", ...value] = filter.split("=");

              return volume.Labels[key] === value.join("=");
            }),
          );

        return { status: 200, json: { Volumes: listed } };
      },
    },
    { method: "DELETE", pattern: /^\/volumes\/([^/]+)$/, handle: removeVolume },
  ];

  const bodyOf = (body: Buffer) => {
    try {
      return body.length === 0 ? undefined : JSON.parse(body.toString("utf8"));
    } catch {
      return undefined;
    }
  };

  const respond = (response: ServerResponse, result: RouteResult) => {
    const payload = result.json === undefined ? result.raw : JSON.stringify(result.json);

    response.writeHead(result.status, {
      "Content-Type": result.json === undefined ? "text/plain" : "application/json",
    });

    response.end(payload);
  };

  const route = (method: string, path: string) =>
    routes
      .filter((candidate) => candidate.method === method)
      .map((candidate) => ({ candidate, match: path.match(candidate.pattern) }))
      .find((entry) => entry.match !== null);

  const handleRequest = async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", "http://engine");
    const body = Buffer.concat((await request.toArray()) as Buffer[]);
    const found = route(request.method ?? "GET", normalizedPath(url));

    requests.push({
      method: request.method ?? "GET",
      path: url.pathname,
      query: url.searchParams,
      body: bodyOf(body),
    });

    if (found === undefined) {
      respond(response, notFound(`page not found: ${request.method} ${url.pathname}`));

      return;
    }

    respond(
      response,
      await found.candidate.handle({ match: found.match as RegExpMatchArray, query: url.searchParams, body }),
    );
  };

  const runSession = async (exec: FakeExec, socket: Socket, leftover: Buffer, unreadBody: () => number) => {
    const chunks = [leftover];
    const ended = new Promise<Buffer>((resolve) => {
      socket.on("data", (chunk: Buffer) => chunks.push(chunk));

      socket.once("end", () => resolve(Buffer.concat(chunks).subarray(unreadBody())));
    });

    const write = (data: string | Buffer, stream: OutputStream = "stdout") => {
      const buffer = Buffer.from(data);

      if (buffer.length > 0) {
        socket.write(exec.body.Tty ? buffer : frame(buffer, stream));
      }
    };

    exec.running = true;

    const exitCode = await execHandler({
      command: exec.body.Cmd,
      tty: exec.body.Tty,
      env: exec.body.Env ?? [],
      workdir: exec.body.WorkingDir ?? "",
      user: exec.body.User,
      input: () => ended,
      write,
    });

    exec.exitCode = exitCode;
    exec.running = false;

    socket.end();
  };

  const startExec = (request: IncomingMessage, socket: Socket, head: Buffer) => {
    const url = new URL(request.url ?? "/", "http://engine");
    const execId = /^\/exec\/([^/]+)\/start$/.exec(normalizedPath(url))?.[1] ?? "";
    const exec = execs.get(execId);

    if (exec === undefined) {
      socket.end("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");

      return;
    }

    socket.write(
      "HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n",
    );

    const body = { length: Number(request.headers["content-length"] ?? 0), read: 0 };

    request.on("data", (chunk: Buffer) => {
      body.read += chunk.length;
    });

    void runSession(exec, socket, head, () => Math.max(0, body.length - body.read));
  };

  const server = createServer((request, response) => {
    void handleRequest(request, response);
  });

  server.on("upgrade", startExec);

  await mkdir(dirname(socketPath), { recursive: true });

  await new Promise<void>((resolve) => server.listen(socketPath, resolve));

  const close = async () => {
    server.closeAllConnections();

    await new Promise((resolve) => server.close(resolve));

    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true });
    }
  };

  return {
    socketPath,
    createdBodies,
    resizes,
    requests,
    images,
    containers,
    volumes,
    volumeLabels,
    networks,
    publish: (reference: string, digest: string) => registry.set(reference, digest),
    close,
  };
};

export type FakeEngine = Awaited<ReturnType<typeof createFakeEngine>>;
