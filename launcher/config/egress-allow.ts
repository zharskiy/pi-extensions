import type { SandboxConfig } from "./types.ts";

const PI_HOSTS: readonly string[] = ["pi.dev"];

export const egressAllowList = (egress: SandboxConfig["egress"]) => [
  ...new Set([...PI_HOSTS, ...egress.allow]),
];
