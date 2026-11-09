import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { rootCertificates } from "node:tls";
import { parseArgs } from "node:util";
import {
  createProcessRunner,
  errorMessage,
  isJsonObject,
  LauncherError,
  parseJsonObject,
  processMark,
  readJsonObject,
  stateLayout,
  writeJsonFile,
} from "../shared/index.ts";
import { createAccessLog } from "./access-log.ts";
import { minimalEnv } from "./child-env.ts";
import { createDialer } from "./dial.ts";
import type { DaemonInput, RepoProxy, RepoProxyInput } from "./files.ts";
import { watchIdle } from "./idle.ts";
import { parentRouteFor } from "./parent.ts";
import { createProxyRuntime } from "./runtime.ts";
import { createSecretResolver, PARENT_PROXY_SECRET_KEY } from "./secrets/index.ts";
import { startProxyServer } from "./server.ts";
import { proxyPolicy } from "./settings.ts";
import { openLauncherCa } from "./tls-ca.ts";

const LISTEN_HOST = "127.0.0.1";

const PRIVATE_MODE = 0o600;

const REPO_HASH = /^[0-9a-f]{64}$/;

const IDLE_CHECKS = 2;

const IDLE_INTERVAL_MS = 30_000;

const parseDaemonArgs = () => {
  const { values } = parseArgs({
    options: {
      repo: { type: "string" },
      state: { type: "string" },
    },
  });

  if (values.repo === undefined || !REPO_HASH.test(values.repo)) {
    throw new LauncherError("--repo <repository hash> is required");
  }

  if (values.state === undefined) {
    throw new LauncherError("--state <state dir> is required");
  }

  return { repoHash: values.repo, stateDir: values.state };
};

type DaemonArgs = ReturnType<typeof parseDaemonArgs>;

const readInput = async (repoHash: string): Promise<DaemonInput> => {
  const text = Buffer.concat((await process.stdin.toArray()) as Buffer[]).toString("utf8");
  const parsed = parseJsonObject(text);
  const input = parsed?.input;

  if (!isJsonObject(input) || typeof parsed?.inputHash !== "string" || input.repoHash !== repoHash) {
    throw new LauncherError("the proxy input on stdin is missing or names another repository");
  }

  return { input: input as unknown as RepoProxyInput, inputHash: parsed.inputHash };
};

const upstreamTrust = async (stateDir: string, extraCa: boolean) => {
  const extra = extraCa ? await readFile(stateLayout(stateDir).extraPem, "utf8").catch(() => "") : "";

  return extra.trim() === "" ? undefined : [...rootCertificates, extra];
};

const reportFailure = async (log: string | undefined, error: unknown) => {
  const hint = error instanceof LauncherError && error.hint !== undefined ? ` (${error.hint})` : "";
  const line = `${new Date().toISOString()} ${errorMessage(error)}${hint}\n`;

  if (log !== undefined) {
    await appendFile(log, line, { mode: PRIVATE_MODE }).catch(() => undefined);
  }

  process.stderr.write(line);

  process.exit(1);
};

const envSecretsOf = (input: RepoProxyInput): ReadonlyMap<string, string> =>
  new Map(
    Object.entries({
      ...input.envSecrets,
      ...(input.parentAuth === undefined ? {} : { [PARENT_PROXY_SECRET_KEY]: input.parentAuth }),
    }),
  );

const run = async (args: DaemonArgs) => {
  const files = stateLayout(args.stateDir).repo(args.repoHash).proxy;
  const { input, inputHash } = await readInput(args.repoHash);
  const childEnv = { ...minimalEnv(process.env), ...input.parentEnv };
  const runner = createProcessRunner({ baseEnv: childEnv });
  const ca = await openLauncherCa({ stateDir: args.stateDir, runner });
  const envSecrets = envSecretsOf(input);
  const resolver = createSecretResolver({
    runner,
    home: homedir(),
    now: Date.now,
    piCommand: input.piCommand,
    stateDir: args.stateDir,
    hostAgentDir: input.hostAgentDir,
    envSecrets: async () => envSecrets,
    childEnv,
    logFile: files.log,
  });
  const log = createAccessLog(files.accessLog, input.accessLogLimit);
  const server = await startProxyServer({
    listen: { host: LISTEN_HOST, port: 0 },
    policy: proxyPolicy(input),
    repoHash: input.repoHash,
    token: input.token,
    runtime: createProxyRuntime({
      stateDir: args.stateDir,
      repoHash: input.repoHash,
      rules: input.rules,
      derivedHosts: input.derivedHosts,
      grantsEnabled: input.grants,
    }),
    resolver,
    privateHosts: input.privateHosts,
    ca,
    log: log.write,
    dial: createDialer({ parent: parentRouteFor(input.parent, input.parentEnv, resolver) }),
    upstreamCa: await upstreamTrust(args.stateDir, input.extraCa),
  });
  const record: RepoProxy = { ...(await processMark()), port: server.port, inputHash };

  await writeJsonFile(files.record, record, { mode: PRIVATE_MODE });

  const removeRecord = async () => {
    const current = await readJsonObject(files.record);

    if (current?.pid === process.pid) {
      await rm(files.record, { force: true });
    }
  };

  const idle = watchIdle({
    stateDir: args.stateDir,
    repoHash: args.repoHash,
    intervalMs: IDLE_INTERVAL_MS,
    emptyChecks: IDLE_CHECKS,
    onIdle: async () => {
      await resolver.close();

      await removeRecord();
    },
  });

  const finish = async () => {
    idle.stop();

    await server.close();

    await log.close();

    process.exit(0);
  };

  const terminate = async () => {
    await removeRecord();

    await finish();
  };

  void idle.idle.then(finish);

  process.once("SIGTERM", () => void terminate());

  process.once("SIGINT", () => void terminate());
};

const startProxyDaemon = async () => {
  const args = await Promise.resolve()
    .then(parseDaemonArgs)
    .catch((error: unknown) => reportFailure(undefined, error));
  const files = stateLayout(args.stateDir).repo(args.repoHash).proxy;

  await mkdir(files.directory, { recursive: true, mode: 0o700 });

  await run(args).catch((error: unknown) => reportFailure(files.log, error));
};

await startProxyDaemon();
