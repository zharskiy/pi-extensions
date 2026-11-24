import { type CliDeps, writeLines } from "../deps.ts";

const COMMANDS: Array<[string, string]> = [
  ["pi [args...]", "run pi in the sandbox for this repository; pi's exit code is pinata's"],
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
    "pinata install [--pi <version>] [--config <file>] [--yes]",
    "set up host pi, the pi link, PATH and the sandbox VM; --pi installs that host pi version, --config writes that file as the config, --yes asks nothing",
  ],
  [
    "pinata update [<version>] [--pi <version>]",
    "install that pinata version with npm (latest without one), then its pinata install --yes",
  ],
  [
    "pinata uninstall",
    "remove the sandbox VM, pinata's state, its links, its PATH block and its package in host pi; your config, sessions, pi and colima stay",
  ],
  [
    "pinata init [--yes]",
    "set up or change the folder that holds your projects, VM size and settings write-back, then apply them to the sandbox VM; --yes asks nothing and applies the current settings",
  ],
  ["pinata status", "runtime, services, container, proxy, image, launches, grants, overlays, volumes"],
  ["pinata list", "the sandbox VM and the pi sessions it runs, for every folder, without starting it"],
  [
    "pinata config [--json]",
    "the effective config and whether each key comes from the config file or the default",
  ],
  ["pinata egress allow <host[:port]>", "allow a host for every session until revoked"],
  ["pinata egress revoke <host[:port]>", "remove a grant"],
  ["pinata egress list [--denied]", "the grants, or the hosts the proxy blocked"],
  [
    "pinata restart",
    "remove the sandbox's containers, volumes and images and restart the VM, once no pi session runs; the next pi rebuilds them, and it asks first when service data or sandbox sessions would go",
  ],
  ["pinata stop", "stop the services and the sandbox VM when no pi session runs"],
  [
    "pinata doctor [--verbose]",
    "prepare the sandbox like pi and report what needs attention by area, with a hint per problem; --verbose lists every check with its detail",
  ],
  ["pinata --version", "print the pinata version"],
  ["pinata help", "show this help"],
];

export const usageOf = (command: string) =>
  COMMANDS.map(([usage]) => usage)
    .filter((usage) => usage === `pinata ${command}` || usage.startsWith(`pinata ${command} `))
    .join(" | ");

const WIDTH = Math.max(...COMMANDS.map(([command]) => command.length));

export const helpCommand = (deps: CliDeps) => {
  writeLines(deps.stdout, [
    "usage:",
    ...COMMANDS.map(([command, description]) => `  ${command.padEnd(WIDTH)}  ${description}`),
  ]);

  return 0;
};
