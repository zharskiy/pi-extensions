import { type CliDeps, writeLines } from "../deps.ts";

const COMMANDS: Array<[string, string]> = [
  ["pi [args...]", "run pi in the sandbox for this repository; pi's exit code is the launcher's"],
  ["pi --no-sandbox [args...]", "run host pi, when fallback is host"],
  ["pi install|remove <source>", "with host pi on the host (-l passes through into the sandbox)"],
  ["pi mcp add|remove|login|logout ...", "with host pi on the host"],
  ["pi update", "update host pi"],
  ["pi sandbox status", "runtime, container, proxy, image, launches, grants, overlays, shared caches"],
  ["pi sandbox config [--json]", "the effective config and the layer each key comes from"],
  [
    "pi sandbox egress allow <host[:port]> [--user]",
    "allow a host for this repository, or with --user for every repository, until revoked",
  ],
  ["pi sandbox egress revoke <host[:port]> [--user]", "remove a grant"],
  ["pi sandbox egress list [--user] [--denied]", "grants, or the hosts the proxy blocked"],
  [
    "pi sandbox gc [--shared-caches]",
    "remove sandboxes no session uses, volumes of deleted repositories and unused images; --shared-caches also your unused shared cache volumes",
  ],
  [
    "pi sandbox reset [--volumes]",
    "remove this repository's sandbox once none of its sessions runs; --volumes also its cache, overlay and agent volumes",
  ],
  ["pi sandbox stop", "stop the sandbox VM when no pi session runs"],
  ["pi sandbox doctor", "prepare the sandbox like pi and print one ok, warn, fail or skip line per check"],
  ["pi sandbox --version", "print the launcher version"],
  ["pi sandbox help", "show this help"],
];

export const usageOf = (command: string) =>
  COMMANDS.map(([usage]) => usage)
    .filter((usage) => usage === `pi sandbox ${command}` || usage.startsWith(`pi sandbox ${command} `))
    .join(" | ");

const WIDTH = Math.max(...COMMANDS.map(([command]) => command.length));

export const helpCommand = (deps: CliDeps) => {
  writeLines(deps.stdout, [
    "usage:",
    ...COMMANDS.map(([command, description]) => `  ${command.padEnd(WIDTH)}  ${description}`),
  ]);

  return 0;
};
