export const LABELS = {
  managed: "pinata.managed",
  install: "pinata.install",
  repoHash: "pinata.repo-hash",
  repoRoot: "pinata.repo-root",
  launchId: "pinata.launch-id",
  imageDigest: "pinata.image-digest",
  relayInputs: "pinata.relay-inputs",
  sessionDir: "pinata.session-dir",
  cachePath: "pinata.cache-path",
  role: "pinata.role",
  serviceName: "pinata.service-name",
  servicesHash: "pinata.services-hash",
} as const;

type Labels = Record<string, string>;

export const roleOf = (labels: Labels) => labels[LABELS.role];

export const isSession = (labels: Labels) => roleOf(labels) === "agent";

export const isOlderBuild = (name: string, labels: Labels) =>
  name.startsWith("pinata-") && labels[LABELS.managed] === "true" && labels[LABELS.install] === undefined;
