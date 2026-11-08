import type { ChildProcess, SpawnOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { RunResult } from "../../shared/index.ts";
import { runFakeScript } from "./fake-engine.ts";
import { createFakeRunner } from "./fake-runner.ts";

interface FakeCliOptions {
  registry?: Record<string, string>;
  systemRunning?: boolean;
}

interface FakeCliContainer {
  id: string;
  image: string;
  labels: Record<string, string>;
  status: "running" | "stopped";
  volumes: string[];
}

interface FakeSpawn {
  args: string[];
  stdio: SpawnOptions["stdio"];
  input: string;
}

interface ParsedArguments {
  flags: Array<[string, string]>;
  switches: string[];
  positional: string[];
}

const SWITCHES = new Set([
  "--read-only",
  "--init",
  "--ssh",
  "--no-dns",
  "--rm",
  "--interactive",
  "--tty",
  "--force",
  "--internal",
  "--all",
]);

const GATEWAY = "192.168.66.1";

const ECHO_INPUT = "cat";

const ok = (stdout = ""): Partial<RunResult> => ({ code: 0, stdout });

const failed = (stderr: string): Partial<RunResult> => ({ code: 1, stderr });

const repositoryOf = (reference: string) => reference.replace(/(@sha256:[0-9a-f]+|:[^/@:]*)$/, "");

const digestOf = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

const parseArguments = (
  args: string[],
  parsed: ParsedArguments = { flags: [], switches: [], positional: [] },
): ParsedArguments => {
  const [head, ...rest] = args;

  if (head === undefined) {
    return parsed;
  }

  if (parsed.positional.length > 0 || !head.startsWith("--")) {
    return { ...parsed, positional: [...parsed.positional, ...args] };
  }

  if (SWITCHES.has(head)) {
    return parseArguments(rest, { ...parsed, switches: [...parsed.switches, head] });
  }

  const [value = "", ...remaining] = rest;

  return parseArguments(remaining, { ...parsed, flags: [...parsed.flags, [head, value]] });
};

const flagValues = (parsed: ParsedArguments, flag: string) =>
  parsed.flags.filter(([name]) => name === flag).map(([, value]) => value);

const mountSource = (parsed: ParsedArguments) =>
  flagValues(parsed, "--mount")
    .flatMap((mount) => mount.split(","))
    .find((part) => part.startsWith("source="))
    ?.slice("source=".length) ?? "";

const networkJson = (name: string, network: { internal: boolean; labels: string[] }) => ({
  id: name,
  config: {
    mode: network.internal ? "hostOnly" : "nat",
    labels: Object.fromEntries(network.labels.map((label) => label.split("="))),
  },
  status: { gateway: GATEWAY },
});

export const createFakeContainerCli = (options: FakeCliOptions = {}) => {
  const registry = new Map(Object.entries(options.registry ?? {}));
  const images = new Map<string, string>();
  const containers = new Map<string, FakeCliContainer>();
  const volumes = new Map<string, Buffer>();
  const networks = new Map<string, { internal: boolean; labels: string[] }>();
  const volumeLabels = new Map<string, string[]>();
  const spawned: FakeSpawn[] = [];
  const envFiles: string[] = [];

  const recordEnvFile = (args: string[]) => {
    const index = args.indexOf("--env-file");

    if (index !== -1) {
      envFiles.push(readFileSync(args[index + 1] ?? "", "utf8"));
    }
  };

  const publishedDigest = (reference: string) => {
    const repository = repositoryOf(reference);
    const pinned = reference.slice(repository.length + 1);
    const byDigest = [...registry.entries()].find(
      ([published, digest]) => repositoryOf(published) === repository && digest === pinned,
    );

    return registry.get(reference) ?? byDigest?.[1];
  };

  const imageCommand = ([action = "", reference = ""]: string[]) => {
    if (action === "list") {
      return ok(JSON.stringify([...images.keys()].map((name) => ({ reference: name }))));
    }

    if (action === "pull") {
      const digest = publishedDigest(reference);

      if (digest === undefined) {
        return failed(`Error: ${reference} not found`);
      }

      images.set(reference, digest);

      return ok();
    }

    const digest = images.get(reference);

    return digest === undefined
      ? failed(`Error: image ${reference} not found`)
      : ok(JSON.stringify([{ name: reference, index: { digest } }]));
  };

  const createCommand = (args: string[]) => {
    const parsed = parseArguments(args);
    const name = flagValues(parsed, "--name")[0] ?? "";
    const image = parsed.positional[0] ?? "";

    if (containers.has(name)) {
      return failed(`Error: container with id ${name} already exists`);
    }

    if (!images.has(image)) {
      return failed(`Error: image ${image} not found`);
    }

    const labels = Object.fromEntries(
      flagValues(parsed, "--label").map((label) => [
        label.split("=")[0],
        label.split("=").slice(1).join("="),
      ]),
    );

    const mounted = flagValues(parsed, "--volume").map((volume) => volume.split(":")[0] ?? "");

    containers.set(name, { id: name, image, labels, status: "stopped", volumes: mounted });

    mounted.forEach((source) => {
      volumes.set(source, volumes.get(source) ?? Buffer.alloc(0));
    });

    return ok(`${name}\n`);
  };

  const setStatus = (id: string, status: FakeCliContainer["status"]) => {
    const container = containers.get(id);

    if (container === undefined) {
      return failed(`Error: container ${id} not found`);
    }

    container.status = status;

    return ok();
  };

  const execCommand = (args: string[], input = "") => {
    const parsed = parseArguments(args);
    const [id = "", ...command] = parsed.positional;

    if (containers.get(id)?.status !== "running") {
      return failed(`Error: container ${id} is not running`);
    }

    return command.at(-1) === ECHO_INPUT ? ok(input) : runFakeScript(command);
  };

  const runCommand = (args: string[]) => {
    const parsed = parseArguments(args);
    const volume = (flagValues(parsed, "--volume")[0] ?? "").split(":")[0] ?? "";
    const [image = "", mode = "", , archive = ""] = parsed.positional;
    const hostFile = join(mountSource(parsed), archive.split("/").at(-1) ?? "");

    if (!images.has(image)) {
      return failed(`Error: image ${image} not found`);
    }

    if (mode === "-c") {
      writeFileSync(hostFile, volumes.get(volume) ?? Buffer.alloc(0));
    }

    if (mode === "-x") {
      volumes.set(volume, readFileSync(hostFile));
    }

    return ok();
  };

  const volumeJson = (name: string) => ({
    name,
    labels: Object.fromEntries(
      (volumeLabels.get(name) ?? []).map((label) => [
        label.split("=")[0],
        label.split("=").slice(1).join("="),
      ]),
    ),
  });

  const volumeCommand = ([action = "", ...rest]: string[]) => {
    const name = rest.at(-1) ?? "";

    if (action === "create") {
      volumes.set(name, volumes.get(name) ?? Buffer.alloc(0));

      volumeLabels.set(name, flagValues(parseArguments(rest), "--label"));

      return ok();
    }

    if (action === "list") {
      return ok(JSON.stringify([...volumes.keys()].map(volumeJson)));
    }

    if (!volumes.has(name)) {
      return failed(`Error: volume ${name} not found`);
    }

    if (action === "delete") {
      volumes.delete(name);

      volumeLabels.delete(name);
    }

    return ok(JSON.stringify([{ name }]));
  };

  const networkCommand = ([action = "", ...rest]: string[]) => {
    const name = rest.at(-1) ?? "";

    if (action === "create") {
      networks.set(name, {
        internal: rest.includes("--internal"),
        labels: flagValues(parseArguments(rest), "--label"),
      });

      return ok();
    }

    if (action === "list") {
      return ok(JSON.stringify([...networks.entries()].map(([id, entry]) => networkJson(id, entry))));
    }

    if (action === "delete") {
      return networks.delete(name) ? ok() : failed(`Error: network ${name} not found`);
    }

    const network = networks.get(name);

    return network === undefined
      ? failed(`Error: network ${name} not found`)
      : ok(JSON.stringify([networkJson(name, network)]));
  };

  const containerJson = (container: FakeCliContainer) => ({
    status: container.status,
    configuration: {
      id: container.id,
      labels: container.labels,
      image: { reference: container.image },
      mounts: container.volumes.map((name) => ({ type: { volume: { name } }, destination: "/data" })),
    },
  });

  const listCommand = () => ok(JSON.stringify([...containers.values()].map(containerJson)));

  const inspectCommand = ([id = ""]: string[]) => {
    const container = containers.get(id);

    return container === undefined
      ? failed(`Error: container ${id} not found`)
      : ok(JSON.stringify([containerJson(container)]));
  };

  const buildCommand = (args: string[]) => {
    const tag = flagValues(parseArguments(args), "--tag")[0] ?? "";

    images.set(tag, digestOf(tag));

    return ok();
  };

  const commands: Record<string, (args: string[]) => Partial<RunResult>> = {
    "--version": () => ok("container CLI version 0.9.0 (fake)\n"),
    system: () =>
      options.systemRunning === false ? failed("apiserver is not running") : ok("apiserver is running\n"),
    image: imageCommand,
    build: buildCommand,
    list: listCommand,
    inspect: inspectCommand,
    create: createCommand,
    start: ([id = ""]) => setStatus(id, "running"),
    stop: (args) => setStatus(parseArguments(args).positional[0] ?? "", "stopped"),
    delete: (args) => {
      const id = args.at(-1) ?? "";

      return containers.delete(id) ? ok() : failed(`Error: container ${id} not found`);
    },
    exec: execCommand,
    run: runCommand,
    volume: volumeCommand,
    network: networkCommand,
  };

  const fake = createFakeRunner((call) => {
    if (call.file !== "container") {
      return undefined;
    }

    const [command = "", ...args] = call.args;

    recordEnvFile(args);

    return commands[command]?.(args) ?? failed(`Error: unknown command ${command}`);
  });

  const spawn = (file: string, args: string[], options: SpawnOptions) => {
    const child = new EventEmitter() as ChildProcess;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const record: FakeSpawn = { args, stdio: options.stdio, input: "" };
    const piped = Array.isArray(options.stdio) && options.stdio[0] === "pipe";

    spawned.push(record);

    recordEnvFile(args);

    Object.assign(child, { stdin: piped ? stdin : null, stdout, stderr, pid: 4000 + spawned.length });

    stdin.on("data", (chunk: Buffer) => {
      record.input += chunk.toString("utf8");
    });

    const finish = () => {
      const [command = "", ...rest] = args;
      const result =
        file === "container" && command === "exec" ? execCommand(rest, record.input) : failed("unknown");

      stdout.end(result.stdout ?? "");

      stderr.end(result.stderr ?? "");

      setImmediate(() => child.emit("close", result.code ?? 0, null));
    };

    if (piped) {
      stdin.once("finish", finish);
    } else {
      setImmediate(finish);
    }

    return child;
  };

  return {
    ...fake,
    spawn,
    spawned,
    envFiles,
    networks,
    volumeLabels,
    images,
    containers,
    volumes,
    publish: (reference: string, digest: string) => registry.set(reference, digest),
  };
};
