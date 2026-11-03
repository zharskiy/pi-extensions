import { appendFile, mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import type { SandboxConfig } from "../config/index.ts";
import {
  createProcessRunner,
  errorMessage,
  LauncherError,
  launcherPaths,
  readJsonFile,
  writeJsonFile,
} from "../shared/index.ts";
import { createAccessLog } from "./access-log.ts";
import { createCredentialSource } from "./credentials.ts";
import { type DaemonConfig, type ProxyInstance, proxyFiles } from "./files.ts";
import { startProxyServer } from "./server.ts";
import { proxyPolicyHash, proxySettings } from "./settings.ts";
import { openLauncherCa } from "./tls-ca.ts";

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
  const policyHash = proxyPolicyHash(config);

  if (policyHash !== args.policyHash) {
    throw new LauncherError(`${files.config}: policy hash does not match ${args.policyHash}`);
  }

  const settings = proxySettings(config);
  const runner = createProcessRunner();
  const ca =
    settings.gateway === undefined ? undefined : await openLauncherCa({ stateDir: args.stateDir, runner });
  const credentials = createCredentialSource(config.credentials, {
    runner,
    env: process.env,
    home: args.home,
    providers: settings.gateway?.providers,
  });
  const log = createAccessLog(files.accessLog);
  const server = await startProxyServer({
    listen: { host: LISTEN_HOST, port: args.port },
    policy: settings.policy,
    policyHash,
    token,
    gateway: settings.gateway === undefined ? undefined : { ...settings.gateway, credentials },
    ca,
    log: log.write,
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
