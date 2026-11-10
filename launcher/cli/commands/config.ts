import { openContext } from "../context.ts";
import { type CliDeps, writeLine, writeLines } from "../deps.ts";

export const JSON_FLAG = "--json";

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
  return showConfig(deps, args.includes(JSON_FLAG));
};
