import { type CliDeps, writeLines } from "../deps.ts";

const USAGE = [
  "usage:",
  "  pi [args...]                        run pi in the sandbox for this repository",
  "  pi --no-sandbox [args...]           run host pi when the policy fallback allows it",
  "  pi install|remove <source>          inside the sandbox, then written to the host settings.json",
  "  pi mcp add|remove|login|logout ...  run on the host",
  "  pi sandbox status                   runtime, container, proxy, image, sessions, grants",
  "  pi sandbox config [--json]          effective config with the source layer of each key",
  "  pi sandbox egress allow <host[:port]> [--user]   for this repository, or every repository",
  "  pi sandbox egress revoke <host[:port]> [--user]",
  "  pi sandbox egress list [--user] [--denied]        grants, or the hosts the proxy blocked",
  "  pi sandbox gc [--shared-caches]    remove stopped containers, idle relays and idle proxies",
  "                                      (--shared-caches: also this user's unused shared cache volumes)",
  "  pi sandbox reset [--volumes]        stop and remove this repo's container (--volumes: caches, older sandbox-only sessions)",
  "  pi sandbox stop                     stop the sandbox VM when no pi session runs; the next pi starts it again",
  "  pi sandbox doctor                   preflight and smoke checks, one line each",
  "  pi sandbox --version                print the launcher version",
  "  pi sandbox help                     show this help",
];

export const helpCommand = (deps: CliDeps) => {
  writeLines(deps.stdout, USAGE);

  return 0;
};
