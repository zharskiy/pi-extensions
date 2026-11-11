const NODE_LOCKFILES = [
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
];

const OVERLAY_MARKERS = new Map([
  ...NODE_LOCKFILES.map((name) => [name, "node_modules"] as const),
  ["uv.lock", ".venv"],
  ["poetry.lock", ".venv"],
  ["Pipfile.lock", ".venv"],
  ["Cargo.lock", "target"],
  ["settings.gradle", ".gradle"],
  ["settings.gradle.kts", ".gradle"],
]);

export const NODE_OVERLAY = "node_modules";

export const isNodeLockfile = (name: string) => NODE_LOCKFILES.includes(name);

export const overlaysMarkedBy = (names: string[]) => [
  ...new Set(names.flatMap((name) => OVERLAY_MARKERS.get(name) ?? [])),
];
