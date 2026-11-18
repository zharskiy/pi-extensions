export const inertGitOptions = (emptyHooksDir: string) => [
  "-c",
  "core.fsmonitor=false",
  "-c",
  `core.hooksPath=${emptyHooksDir}`,
];
