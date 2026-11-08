import { join } from "node:path";
import { ensureRandomHexFile } from "./atomic-write.ts";

const SALT_BYTES = 32;

export const GUEST_PATHS = {
  agentDir: "/home/pi/.pi/agent",
  renderDir: "/opt/pi-sandbox/render",
  trustPem: "/etc/pi-sandbox/ca.pem",
} as const;

const proxyInstanceFiles = (stateDir: string, policyHash: string) => {
  const directory = join(stateDir, "proxy", policyHash);
  const dynamic = join(directory, "dynamic.json");

  return {
    directory,
    record: join(directory, "proxy.json"),
    config: join(directory, "proxy-config.json"),
    token: join(directory, "proxy-token"),
    port: join(directory, "proxy-port"),
    accessLog: join(directory, "proxy-access.log"),
    proxyLog: join(directory, "proxy.log"),
    lock: join(directory, "lock"),
    dynamic,
    dynamicLock: `${dynamic}.lock`,
    tokensDir: join(directory, "tokens"),
    repoToken: (repoHash: string) => join(directory, "tokens", repoHash),
  };
};

export const stateLayout = (stateDir: string) => ({
  salt: join(stateDir, "salt"),
  grants: join(stateDir, "grants.json"),
  sessions: join(stateDir, "sessions"),
  sessionsOf: (repoHash: string) => join(stateDir, "sessions", repoHash),
  render: (repoHash: string) => join(stateDir, "render", repoHash),
  gitNoHooks: join(stateDir, "git", "no-hooks"),
  gitSnapshots: (repoHash: string) => join(stateDir, "git", repoHash, "snapshots"),
  gitBaseline: (repoHash: string) => join(stateDir, "git", repoHash, "baseline.json"),
  gitPinLock: (gitCommonDirHash: string) => join(stateDir, "git", "pins", `${gitCommonDirHash}.lock`),
  sync: (repoHash: string) => join(stateDir, "sync", repoHash),
  mcpAuth: join(stateDir, "mcp-auth"),
  mcpAuthServer: (name: string) => join(stateDir, "mcp-auth", "servers", `${name}.json`),
  mcpAuthStore: join(stateDir, "mcp-auth", "mcp-auth.json"),
  mcpAuthStoreLock: join(stateDir, "mcp-auth", "mcp-auth.json.lock"),
  mcpAuthDiscovery: (name: string) => join(stateDir, "mcp-auth", "discovery", `${name}.json`),
  mcpAuthRefreshLock: (name: string) => join(stateDir, "mcp-auth", `refresh-${name}.lock`),
  syncMcpAuth: (repoHash: string) => join(stateDir, "sync", repoHash, "mcp-auth.json"),
  providerHosts: (piVersion: string) => join(stateDir, "provider-hosts", `${piVersion}.json`),
  ca: join(stateDir, "ca"),
  extraPem: join(stateDir, "ca", "extra.pem"),
  trustPem: join(stateDir, "ca", "trust.pem"),
  imageRecord: join(stateDir, "image.json"),
  wanted: (repoKey: string) => join(stateDir, "wanted", `${repoKey}.json`),
  proxyRoot: join(stateDir, "proxy"),
  proxyInstance: (policyHash: string) => proxyInstanceFiles(stateDir, policyHash),
});

export const ensureSalt = (stateDir: string) => ensureRandomHexFile(stateLayout(stateDir).salt, SALT_BYTES);
