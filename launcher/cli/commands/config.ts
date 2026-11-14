import { type WriteBackListing, writeBackListing } from "../../config/index.ts";
import { openContext } from "../context.ts";
import { type CliDeps, writeLine, writeLines } from "../deps.ts";

export const JSON_FLAG = "--json";

const SOURCES = ["default", "config"] as const;

const writeBackLines = (listing: WriteBackListing) => {
  if (Object.keys(listing).length === 0) {
    return ["# writeBack: nothing is written back to the host"];
  }

  return Object.entries(listing).flatMap(([file, keys]) =>
    SOURCES.flatMap((source) => {
      const named = Object.entries(keys)
        .filter(([, entry]) => entry.source === source)
        .map(([key]) => key);

      return named.length === 0 ? [] : [`# writeBack ${file} ${source}: ${named.join(", ")}`];
    }),
  );
};

const showConfig = async (deps: CliDeps, json: boolean) => {
  const { effective } = (await openContext(deps, "host")).context;
  const writeBack = writeBackListing(effective.config.writeBack);

  if (json) {
    writeLine(deps.stdout, JSON.stringify({ ...effective, writeBack }, null, 2));

    return 0;
  }

  const listing = Object.entries(effective.sources)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, source]) => `# ${key}: ${source}`);

  writeLines(deps.stdout, [
    JSON.stringify(effective.config, null, 2),
    ...listing,
    ...writeBackLines(writeBack),
  ]);

  return 0;
};

export const configCommand = async (deps: CliDeps, args: string[]) => {
  return showConfig(deps, args.includes(JSON_FLAG));
};
