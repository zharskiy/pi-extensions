import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "./atomic-write.ts";

const SALT_BYTES = 32;

const SALT_PATTERN = new RegExp(`^[0-9a-f]{${SALT_BYTES * 2}}$`);

const PRIVATE_MODE = 0o600;

export const GUEST_PATHS = {
  agentDir: "/home/pi/.pi/agent",
  renderDir: "/opt/pi-sandbox/render",
  trustPem: "/etc/pi-sandbox/ca.pem",
} as const;

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
  org: join(stateDir, "org"),
  trustPem: join(stateDir, "ca", "trust.pem"),
  proxyInstance: (policyHash: string) => join(stateDir, "proxy", policyHash),
  proxyDynamic: (policyHash: string) => join(stateDir, "proxy", policyHash, "dynamic.json"),
  proxyRepoToken: (policyHash: string, repoHash: string) =>
    join(stateDir, "proxy", policyHash, "tokens", repoHash),
});

const readSalt = async (path: string) => {
  const text = await readFile(path, "utf8").catch(() => "");

  return SALT_PATTERN.test(text) ? text : undefined;
};

const createSalt = async (path: string) => {
  const salt = randomBytes(SALT_BYTES).toString("hex");

  await mkdir(dirname(path), { recursive: true, mode: 0o700 });

  const created = await writeFile(path, salt, { mode: PRIVATE_MODE, flag: "wx" }).then(
    () => true,
    () => false,
  );

  if (created) {
    return salt;
  }

  const raced = await readSalt(path);

  if (raced !== undefined) {
    return raced;
  }

  await writeFileAtomic(path, salt, { mode: PRIVATE_MODE });

  return salt;
};

export const ensureSalt = async (stateDir: string) => {
  const path = stateLayout(stateDir).salt;

  return (await readSalt(path)) ?? createSalt(path);
};
