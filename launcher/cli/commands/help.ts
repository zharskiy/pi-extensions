import { type CliDeps, writeLines } from "../deps.ts";

const COMMANDS: Array<[string, string]> = [
  ["pi [args...]", "run pi in the sandbox for this repository; pi's exit code is the launcher's"],
  ["pi --no-sandbox [args...]", "run host pi, outside the sandbox"],
  ["pi install|remove <source>", "with host pi on the host (-l passes through into the sandbox)"],
  ["pi mcp add|remove|login|logout ...", "with host pi on the host"],
  ["pi auth ...", "with host pi on the host, against the logins the proxy uses"],
  ["pi [command] --help", "pi's help, with host pi on the host"],
  ["pi --list-models [search]", "with host pi on the host"],
  ["pi --export <file> [out]", "with host pi on the host"],
  ["pi --version", "the pi version the sandbox runs, without starting a sandbox"],
  ["pi update [target]", "update host pi, its packages or its model catalogs, with host pi on the host"],
  ["pi config", "the user resource config, with host pi on the host (-l passes through into the sandbox)"],
  [
    "pi sandbox init [--yes]",
    "set up or change the project folders, VM size and settings write-back, then apply them to the sandbox VM; --yes asks nothing and applies the current settings",
  ],
  ["pi sandbox status", "runtime, services, container, proxy, image, launches, grants, overlays, volumes"],
  [
    "pi sandbox config [--json]",
    "the effective config and whether each key comes from the config file or the default",
  ],
  ["pi sandbox egress allow <host[:port]>", "allow a host for every session until revoked"],
  ["pi sandbox egress revoke <host[:port]>", "remove a grant"],
  ["pi sandbox egress list [--denied]", "the grants, or the hosts the proxy blocked"],
  [
    "pi sandbox reset [--services]",
    "remove this folder's sandbox with its overlay and agent volumes, once none of its sessions runs; --services instead removes the sandbox's services and their data, once no pi session runs",
  ],
  ["pi sandbox stop", "stop the services and the sandbox VM when no pi session runs"],
  [
    "pi sandbox doctor [--verbose]",
    "prepare the sandbox like pi and report each check by area, with a hint per problem; --verbose lists every credential rule",
  ],
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
