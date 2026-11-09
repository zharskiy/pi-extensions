import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Writable } from "node:stream";
import { createColimaBackend } from "../../../backend/index.ts";
import { createProcessRunner } from "../../../shared/index.ts";
import { engineSocket, listContainers, startContainer } from "./engine.ts";
import type { LiveSandbox } from "./sandbox.ts";

export type Secrets = Record<string, string>;

export interface Finding {
  where: string;
  secret: string;
}

const FILESYSTEM = "tar -cf - --exclude=./proc --exclude=./sys --exclude=./dev -C / . 2>/dev/null; true";

const ENVIRONMENT = "env; printf '\\n'; cat /proc/[0-9]*/environ 2>/dev/null | tr '\\000' '\\n'; true";

const BUILD_CONTEXT = /^(build|layer)-/;

const scanner = (secrets: Secrets) => {
  const longest = Math.max(...Object.values(secrets).map((value) => value.length));
  const found = new Set<string>();
  const state = { tail: Buffer.alloc(0), bytes: 0 };
  const needles = Object.entries(secrets).map(([name, value]) => ({ name, value: Buffer.from(value) }));

  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      const window = Buffer.concat([state.tail, chunk]);

      needles
        .filter((needle) => window.includes(needle.value))
        .forEach((needle) => {
          found.add(needle.name);
        });

      state.tail = window.subarray(Math.max(0, window.length - longest));

      state.bytes += chunk.length;

      callback();
    },
  });

  return { stream, found: () => [...found], bytes: () => state.bytes };
};

const scanContainer = async (repoHash: string, script: string, secrets: Secrets) => {
  const containers = await listContainers({ "pi-sandbox.repo-hash": repoHash });
  const agent = containers.find((container) => container.Labels["pi-sandbox.relay"] !== "true");

  if (agent === undefined) {
    throw new Error("no sandbox container to sweep");
  }

  await startContainer(agent.Id);

  const backend = createColimaBackend({
    home: "",
    stateDir: "",
    socketPath: engineSocket ?? "",
    runner: createProcessRunner(),
  });
  const out = scanner(secrets);
  const err = scanner(secrets);

  await backend.exec(
    { containerId: agent.Id, command: ["sh", "-c", script], env: {}, workdir: "/" },
    { stdout: out.stream, stderr: err.stream, tty: false },
  );

  return { found: [...out.found(), ...err.found()], bytes: out.bytes() };
};

const filesUnder = async (dir: string): Promise<string[]> => {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory() ? filesUnder(join(dir, entry.name)) : Promise.resolve([join(dir, entry.name)]),
    ),
  );

  return nested.flat();
};

const buildContextFindings = async (stateDir: string, secrets: Secrets): Promise<Finding[]> => {
  const entries = await readdir(stateDir).catch(() => [] as string[]);
  const contexts = entries.filter((entry) => BUILD_CONTEXT.test(entry)).map((entry) => join(stateDir, entry));
  const files = (await Promise.all(contexts.map(filesUnder))).flat();
  const texts = await Promise.all(
    files.map(async (file) => ({ file, text: await readFile(file, "latin1") })),
  );

  return texts.flatMap(({ file, text }) =>
    Object.entries(secrets)
      .filter(([, value]) => text.includes(value))
      .map(([secret]) => ({ where: file, secret })),
  );
};

export const sweepSandbox = async (sandbox: LiveSandbox, secrets: Secrets) => {
  const filesystem = await scanContainer(sandbox.repoHash, FILESYSTEM, secrets);
  const environment = await scanContainer(sandbox.repoHash, ENVIRONMENT, secrets);
  const findings: Finding[] = [
    ...filesystem.found.map((secret) => ({ where: "container filesystem", secret })),
    ...environment.found.map((secret) => ({ where: "container env", secret })),
    ...(await buildContextFindings(sandbox.stateDir, secrets)),
  ];

  console.log(`secret sweep: ${filesystem.bytes} bytes of filesystem scanned, ${findings.length} findings`);

  return { findings, scannedBytes: filesystem.bytes };
};
