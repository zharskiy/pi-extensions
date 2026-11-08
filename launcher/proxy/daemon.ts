import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { rootCertificates } from "node:tls";
import { parseArgs } from "node:util";
import type { SandboxConfig } from "../config/index.ts";
import {
  createProcessRunner,
  errorMessage,
  LauncherError,
  launcherPaths,
  readJsonFile,
  readJsonObject,
  stateLayout,
  writeJsonFile,
} from "../shared/index.ts";
import { createAccessLog } from "./access-log.ts";
import { minimalEnv } from "./child-env.ts";
import { createDialer } from "./dial.ts";
import type { DaemonConfig, ProxyInstance } from "./files.ts";
import { parentRouteFor } from "./parent.ts";
import { createRepoSecrets } from "./repo-secrets.ts";
import { createProxyRuntime } from "./runtime.ts";
import { createSecretResolver } from "./secrets/index.ts";
import { startProxyServer } from "./server.ts";
import { proxyPolicyHash, proxySettings } from "./settings.ts";
import { testResolveOverrides } from "./test-resolve.ts";
import { openLauncherCa } from "./tls-ca.ts";
import { createVault } from "./vault/index.ts";

const LISTEN_HOST = "127.0.0.1";

const PRIVATE_MODE = 0o600;

const parseDaemonArgs = () => {
  const { values } = parseArgs({
    options: {
      hash: { type: "string" },
      port: { type: "string" },
      state: { type: "string" },
      home: { type: "string" },
    },
  });

  if (values.hash === undefined || !/^[0-9a-f]{64}$/.test(values.hash)) {
    throw new LauncherError("--hash <policy hash> is required");
  }

  return {
    policyHash: values.hash,
    port: Number(values.port ?? "0"),
    stateDir: values.state ?? launcherPaths().stateDir,
    home: values.home ?? homedir(),
  };
};

const upstreamTrust = async (stateDir: string, hasExtraCa: boolean) => {
  const extra = hasExtraCa ? await readFile(stateLayout(stateDir).extraPem, "utf8").catch(() => "") : "";

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

const run = async (args: ReturnType<typeof parseDaemonArgs>) => {
  const files = stateLayout(args.stateDir).proxyInstance(args.policyHash);
  const daemonConfig = await readJsonFile<DaemonConfig<SandboxConfig>>(files.config);

  if (daemonConfig === undefined) {
    throw new LauncherError(`${files.config}: not found`);
  }

  const { config, token } = daemonConfig;
  const cap = daemonConfig.egressCap ?? {};
  const policyHash = proxyPolicyHash(config, cap);

  if (policyHash !== args.policyHash) {
    throw new LauncherError(`${files.config}: policy hash does not match ${args.policyHash}`);
  }

  const settings = proxySettings(config, cap);
  const parentEnv = daemonConfig.parentEnv ?? {};
  const runner = createProcessRunner({ baseEnv: { ...minimalEnv(process.env), ...parentEnv } });
  const ca = await openLauncherCa({ stateDir: args.stateDir, runner });

  await ca.pruneLeaves();

  const runtime = createProxyRuntime({
    stateDir: args.stateDir,
    policyHash,
    staticRules: settings.rules,
    grantsEnabled: settings.grants.enabled,
    cap: settings.cap,
  });
  const secrets = createRepoSecrets(runtime);
  const resolver = createSecretResolver({
    runner,
    home: args.home,
    now: Date.now,
    piCommand: daemonConfig.piCommand ?? [],
    stateDir: args.stateDir,
    envSecrets: secrets.secretsOf,
  });
  const log = createAccessLog(files.accessLog);
  const vault = createVault({
    stateDir: args.stateDir,
    servers: (repoHash) => runtime.vault(repoHash),
    resolver,
    runner,
    discoverCommand: daemonConfig.discoverCommand ?? [],
  });
  const server = await startProxyServer({
    listen: { host: LISTEN_HOST, port: args.port },
    policy: settings.policy,
    policyHash,
    controlToken: token,
    runtime,
    resolver,
    gateway: settings.gateway,
    privateHosts: settings.privateHosts,
    ca,
    log: log.write,
    dial: createDialer({
      parent: parentRouteFor(settings.parentProxy, parentEnv, resolver),
      overrides: testResolveOverrides(process.env),
    }),
    upstreamCa: await upstreamTrust(args.stateDir, settings.extraCa.length > 0),
    vault,
    onControl: secrets.accept,
  });
  const record: ProxyInstance = {
    policyHash,
    port: server.port,
    token,
    pid: process.pid,
  };

  await writeJsonFile(files.record, record, { mode: PRIVATE_MODE });

  const shutdown = async () => {
    await server.close();

    await log.close();

    const current = await readJsonObject(files.record);

    if (current?.pid === process.pid) {
      await rm(files.record, { force: true });
    }

    process.exit(0);
  };

  process.once("SIGTERM", () => void shutdown());

  process.once("SIGINT", () => void shutdown());
};

const startProxyDaemon = async () => {
  const args = await Promise.resolve()
    .then(parseDaemonArgs)
    .catch((error: unknown) => reportFailure(undefined, error));

  const files = stateLayout(args.stateDir).proxyInstance(args.policyHash);

  await mkdir(files.directory, { recursive: true, mode: 0o700 });

  await run(args).catch((error: unknown) => reportFailure(files.proxyLog, error));
};

await startProxyDaemon();
