import { join } from "node:path";
import { ensureRandomHexFile } from "./atomic-write.ts";
import { sha256Hex } from "./hash.ts";
import { isWithin } from "./paths.ts";

const SALT_BYTES = 32;

export const GUEST_HOME = "/home/pi";

const RENDER_DIR = "/opt/pi-sandbox/render";

export const RENDER_STATUS_FILE = "tools/status.json";

export const GUEST_PATHS = {
  agentDir: `${GUEST_HOME}/.pi/agent`,
  agentsSkills: `${GUEST_HOME}/.agents/skills`,
  renderDir: RENDER_DIR,
  statusFile: `${RENDER_DIR}/${RENDER_STATUS_FILE}`,
  caBundle: "/etc/ssl/certs/ca-certificates.crt",
  sandboxCaDir: "/usr/local/share/ca-certificates/pi-sandbox",
  entrypoint: "/usr/local/bin/pi-sandbox-entrypoint",
  handover: "/tmp/pi-sandbox-handover",
  ready: "/tmp/pi-sandbox-ready",
  forwardStatus: "/tmp/pi-sandbox-forward",
} as const;

const SYSTEM_TREES = [
  "/usr",
  "/bin",
  "/sbin",
  "/lib",
  "/lib32",
  "/lib64",
  "/libx32",
  "/boot",
  "/dev",
  "/proc",
  "/sys",
  "/run",
  "/var/run",
  "/var/lock",
  "/root",
  "/opt/pi-sandbox",
  "/etc/ssl",
];

const ETC_ENTRIES = [
  "ld.so.preload",
  "ld.so.cache",
  "ld.so.conf",
  "ld.so.conf.d",
  "passwd",
  "group",
  "shadow",
  "gshadow",
  "nsswitch.conf",
  "hosts",
  "hostname",
  "resolv.conf",
];

export const GUEST_TREES = [...SYSTEM_TREES, ...ETC_ENTRIES.map((entry) => `/etc/${entry}`)];

export const GUEST_MOUNT_POINTS = [GUEST_HOME, "/tmp"];

export const GUEST_MARKERS = [GUEST_PATHS.handover, GUEST_PATHS.ready, GUEST_PATHS.forwardStatus];

const overlaps = (one: string, other: string) => isWithin(one, other) || isWithin(other, one);

export const guestReservedOver = (target: string) =>
  GUEST_TREES.find((tree) => overlaps(tree, target)) ??
  GUEST_MOUNT_POINTS.find((point) => isWithin(point, target)) ??
  GUEST_MARKERS.find((marker) => overlaps(marker, target));

const proxyFiles = (directory: string) => ({
  directory,
  record: join(directory, "proxy.json"),
  token: join(directory, "token"),
  log: join(directory, "proxy.log"),
  accessLog: join(directory, "access.log"),
  egress: join(directory, "egress.json"),
});

const repoFiles = (stateDir: string, repoHash: string) => {
  const directory = join(stateDir, "repos", repoHash);

  return {
    directory,
    record: join(directory, "repo.json"),
    prepareLock: join(stateDir, "locks", `prepare-${repoHash}.lock`),
    render: join(stateDir, "vm", "render", repoHash),
    renderLock: join(directory, "render.lock"),
    sync: join(directory, "sync"),
    syncLock: join(directory, "sync", "sync.lock"),
    syncBaseline: join(directory, "sync", "baseline.json"),
    syncPackages: join(directory, "sync", "packages.json"),
    gitBaseline: join(directory, "git", "baseline.json"),
    created: join(directory, "created.json"),
  };
};

export const stateLayout = (stateDir: string) => ({
  salt: join(stateDir, "salt"),
  grants: join(stateDir, "grants.json"),
  grantsLock: join(stateDir, "grants.json.lock"),
  seen: join(stateDir, "seen.json"),
  repos: join(stateDir, "repos"),
  repo: (repoHash: string) => repoFiles(stateDir, repoHash),
  vm: join(stateDir, "vm"),
  emptyDir: join(stateDir, "empty"),
  vmLock: join(stateDir, "locks", "vm.lock"),
  groundLock: join(stateDir, "locks", "ground.lock"),
  launches: join(stateDir, "launches"),
  launchesLock: join(stateDir, "locks", "launches.lock"),
  proxy: proxyFiles(join(stateDir, "proxy")),
  build: join(stateDir, "build"),
  buildContext: (name: string) => join(stateDir, "build", name),
  buildLock: join(stateDir, "locks", "build.lock"),
  mcpLogin: join(stateDir, "mcp-login.json"),
  mcpLoginFileLock: join(stateDir, "locks", "mcp-login-file.lock"),
  mcpLoginDirPrefix: join(stateDir, "mcp-login-"),
  mcpLoginLock: (key: string) => join(stateDir, "locks", `mcp-login-${sha256Hex(key).slice(0, 8)}.lock`),
  providerHosts: (piVersion: string) => join(stateDir, "provider-hosts", `${piVersion}.json`),
  ca: join(stateDir, "ca"),
  caLock: join(stateDir, "ca", "ca.lock"),
  extraPem: join(stateDir, "ca", "extra.pem"),
  imageRecord: join(stateDir, "image.json"),
  gcRecord: join(stateDir, "gc.json"),
});

export const ensureSalt = (stateDir: string) => ensureRandomHexFile(stateLayout(stateDir).salt, SALT_BYTES);
