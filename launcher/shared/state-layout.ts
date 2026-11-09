import { join } from "node:path";
import { ensureRandomHexFile } from "./atomic-write.ts";
import { sha256Hex } from "./hash.ts";

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

const repoFiles = (stateDir: string, repoHash: string) => {
  const directory = join(stateDir, "repos", repoHash);

  return {
    directory,
    launches: join(directory, "launches"),
    lock: join(directory, "lock"),
    render: join(directory, "render"),
    sync: join(directory, "sync"),
    gitSnapshots: join(directory, "git", "snapshots"),
    gitBaseline: join(directory, "git", "baseline.json"),
    wanted: join(directory, "wanted.json"),
  };
};

export const stateLayout = (stateDir: string) => ({
  salt: join(stateDir, "salt"),
  grants: join(stateDir, "grants.json"),
  repos: join(stateDir, "repos"),
  repo: (repoHash: string) => repoFiles(stateDir, repoHash),
  gitNoHooks: join(stateDir, "git", "no-hooks"),
  gitPinLock: (gitCommonDirHash: string) => join(stateDir, "locks", `git-${gitCommonDirHash}.lock`),
  vmLock: join(stateDir, "locks", "vm.lock"),
  buildContext: (name: string) => join(stateDir, name),
  mcpLogin: join(stateDir, "mcp-login.json"),
  mcpLoginDirPrefix: join(stateDir, "mcp-login-"),
  mcpLoginLock: (key: string) => join(stateDir, "locks", `mcp-login-${sha256Hex(key).slice(0, 8)}.lock`),
  providerHosts: (piVersion: string) => join(stateDir, "provider-hosts", `${piVersion}.json`),
  ca: join(stateDir, "ca"),
  extraPem: join(stateDir, "ca", "extra.pem"),
  trustPem: join(stateDir, "ca", "trust.pem"),
  imageRecord: join(stateDir, "image.json"),
  proxyRoot: join(stateDir, "proxy"),
  proxyInstance: (policyHash: string) => proxyInstanceFiles(stateDir, policyHash),
});

export const ensureSalt = (stateDir: string) => ensureRandomHexFile(stateLayout(stateDir).salt, SALT_BYTES);
