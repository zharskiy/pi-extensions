import { join } from "node:path";
import { ensureRandomHexFile } from "./atomic-write.ts";
import { sha256Hex } from "./hash.ts";

const SALT_BYTES = 32;

export const GUEST_PATHS = {
  agentDir: "/home/pi/.pi/agent",
  renderDir: "/opt/pi-sandbox/render",
  trustPem: "/etc/pi-sandbox/ca.pem",
} as const;

const GIT_COPY_NAME = 16;

const repoProxyFiles = (directory: string) => ({
  directory,
  record: join(directory, "proxy.json"),
  token: join(directory, "token"),
  log: join(directory, "proxy.log"),
  accessLog: join(directory, "access.log"),
});

const repoFiles = (stateDir: string, repoHash: string) => {
  const directory = join(stateDir, "repos", repoHash);
  const git = join(directory, "git");

  return {
    directory,
    record: join(directory, "repo.json"),
    launches: join(directory, "launches"),
    lock: join(directory, "lock"),
    containerLock: join(directory, "container.lock"),
    render: join(directory, "render"),
    sync: join(directory, "sync"),
    git,
    gitCopy: (path: string) => join(git, sha256Hex(path).slice(0, GIT_COPY_NAME)),
    gitBaseline: join(git, "baseline.json"),
    pins: join(directory, "pins.json"),
    created: join(directory, "created.json"),
    image: join(directory, "image.json"),
    proxy: repoProxyFiles(join(directory, "proxy")),
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
  build: join(stateDir, "build"),
  buildContext: (name: string) => join(stateDir, "build", name),
  buildLock: join(stateDir, "locks", "build.lock"),
  mcpLogin: join(stateDir, "mcp-login.json"),
  mcpLoginDirPrefix: join(stateDir, "mcp-login-"),
  mcpLoginLock: (key: string) => join(stateDir, "locks", `mcp-login-${sha256Hex(key).slice(0, 8)}.lock`),
  providerHosts: (piVersion: string) => join(stateDir, "provider-hosts", `${piVersion}.json`),
  ca: join(stateDir, "ca"),
  extraPem: join(stateDir, "ca", "extra.pem"),
  trustPem: join(stateDir, "ca", "trust.pem"),
  imageRecord: join(stateDir, "image.json"),
  gcRecord: join(stateDir, "gc.json"),
  seen: join(stateDir, "seen.json"),
});

export const ensureSalt = (stateDir: string) => ensureRandomHexFile(stateLayout(stateDir).salt, SALT_BYTES);
