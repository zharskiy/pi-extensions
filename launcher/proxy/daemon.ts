import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { rootCertificates } from "node:tls";
import { parseArgs } from "node:util";
import { legacyGatewayRule, type SandboxConfig } from "../config/index.ts";
import {
  createProcessRunner,
  errorMessage,
  LauncherError,
  launcherPaths,
  readJsonFile,
  stateLayout,
  writeJsonFile,
} from "../shared/index.ts";
import { createAccessLog } from "./access-log.ts";
import { createDialer } from "./dial.ts";
import { type DaemonConfig, type ProxyInstance, proxyFiles } from "./files.ts";
import { parentRouteFor } from "./parent.ts";
import { createProxyRuntime } from "./runtime.ts";
import { createSecretResolver } from "./secrets/index.ts";
import { startProxyServer } from "./server.ts";
import { proxyPolicyHash, proxySettings } from "./settings.ts";
import { openLauncherCa } from "./tls-ca.ts";
import { extraPemPathOf } from "./trust.ts";

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
  const extra = hasExtraCa ? await readFile(extraPemPathOf(stateDir), "utf8").catch(() => "") : "";

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
  const files = proxyFiles(args.stateDir, args.policyHash);
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
  const runner = createProcessRunner();
  const ca = await openLauncherCa({ stateDir: args.stateDir, runner });
  const secrets = { current: new Map<string, string>() };
  const resolver = createSecretResolver({
    runner,
    home: args.home,
    now: Date.now,
    piCommand: daemonConfig.piCommand ?? [],
    mcpAuthDir: stateLayout(args.stateDir).mcpAuth,
    envSecrets: () => secrets.current,
  });
  const gatewayRule = legacyGatewayRule(config, process.env);
  const runtime = createProxyRuntime({
    stateDir: args.stateDir,
    policyHash,
    staticRules: [...(gatewayRule === undefined ? [] : [gatewayRule]), ...settings.rules],
    grantsEnabled: settings.grants.enabled,
    cap: settings.cap,
  });
  const log = createAccessLog(files.accessLog);
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
    dial: createDialer({ parent: parentRouteFor(settings.parentProxy, process.env, resolver) }),
    upstreamCa: await upstreamTrust(args.stateDir, settings.extraCa.length > 0),
    onControl: (message) => {
      secrets.current = new Map(Object.entries(message.secrets));

      return { ok: true };
    },
  });
  const record: ProxyInstance = { policyHash, port: server.port, token, pid: process.pid };

  await writeJsonFile(files.record, record, { mode: PRIVATE_MODE });

  const shutdown = async () => {
    await server.close();

    await log.close();

    const current = await readJsonFile<ProxyInstance>(files.record).catch(() => undefined);

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

  await mkdir(proxyFiles(args.stateDir, args.policyHash).directory, { recursive: true, mode: 0o700 });

  await run(args).catch((error: unknown) =>
    reportFailure(proxyFiles(args.stateDir, args.policyHash).proxyLog, error),
  );
};

await startProxyDaemon();
