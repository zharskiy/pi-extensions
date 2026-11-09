import { LauncherError } from "../../shared/index.ts";
import { type CliDeps, writeLine, writeLines } from "../deps.ts";
import { openContext } from "../launch.ts";

const showConfig = async (deps: CliDeps, json: boolean) => {
  const { effective } = (await openContext(deps, "host")).context;

  if (json) {
    writeLine(deps.stdout, JSON.stringify(effective, null, 2));

    return 0;
  }

  const listing = Object.entries(effective.sources)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, layer]) => `# ${key}: ${layer}`);
  const ignored = effective.ignored.map((entry) => `# ignored ${entry.layer} ${entry.key}: ${entry.reason}`);

  writeLines(deps.stdout, [JSON.stringify(effective.config, null, 2), ...listing, ...ignored]);

  return 0;
};

export const configCommand = async (deps: CliDeps, args: string[]) => {
  const [action] = args;

  if (args.length > 1 || (action !== undefined && action !== "--json")) {
    throw new LauncherError(`unknown config option "${args.join(" ")}"`, "pi sandbox config [--json]");
  }

  return showConfig(deps, action === "--json");
};
