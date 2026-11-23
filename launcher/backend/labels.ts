export const LABELS = {
  managed: "pi-sandbox.managed",
  install: "pi-sandbox.install",
  repoHash: "pi-sandbox.repo-hash",
  repoRoot: "pi-sandbox.repo-root",
  launchId: "pi-sandbox.launch-id",
  imageDigest: "pi-sandbox.image-digest",
  relayInputs: "pi-sandbox.relay-inputs",
  sessionDir: "pi-sandbox.session-dir",
  cachePath: "pi-sandbox.cache-path",
  role: "pi-sandbox.role",
  serviceName: "pi-sandbox.service-name",
  servicesHash: "pi-sandbox.services-hash",
} as const;

type Labels = Record<string, string>;

export const roleOf = (labels: Labels) => labels[LABELS.role];

export const isSession = (labels: Labels) => roleOf(labels) === "agent";

export const isOlderBuild = (name: string, labels: Labels) =>
  name.startsWith("pi-sandbox-") && labels[LABELS.managed] === "true" && labels[LABELS.install] === undefined;
