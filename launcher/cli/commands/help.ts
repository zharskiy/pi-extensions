import { BACKEND_NAMES } from "../../shared/index.ts";
import { type CliDeps, writeLines } from "../deps.ts";

const USAGE = [
  "usage:",
  "  pi [args...]                        run pi in the sandbox for this repository",
  "  pi --no-sandbox [args...]           run host pi when the policy fallback allows it",
  "  pi sandbox status                   backend, container, proxy, image digest, gaps",
  "  pi sandbox config [--json]          effective config with the source layer of each key",
  "  pi sandbox config set <key> <json value> [--project]",
  "  pi sandbox gc                       remove stopped containers, idle relays and idle proxies",
  "  pi sandbox reset [--volumes]        stop and remove this repo's container",
  "  pi sandbox doctor                   preflight and smoke checks, one line each",
  `  pi sandbox migrate --to <backend>   move the volumes to another backend (${BACKEND_NAMES.join(", ")})`,
  "  pi sandbox --version                print the launcher version",
  "  pi sandbox help                     show this help",
];

export const helpCommand = (deps: CliDeps) => {
  writeLines(deps.stdout, USAGE);

  return 0;
};
