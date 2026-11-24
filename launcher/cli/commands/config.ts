import { type EffectiveConfig, type WriteBackListing, writeBackListing } from "../../config/index.ts";
import { openContext } from "../context.ts";
import { type CliDeps, pathsOf, writeLine } from "../deps.ts";
import { stepsOf, tilde } from "../steps.ts";

const keysFrom = (listing: WriteBackListing[string], source: string) =>
  Object.entries(listing)
    .filter(([, entry]) => entry.source === source)
    .map(([key]) => key);

const writeBackText = (file: string, keys: WriteBackListing[string]) => {
  const configured = keysFrom(keys, "config");
  const parts = [...keysFrom(keys, "default"), ...configured.map((key) => `${key} (from the config)`)];

  return `${file}: ${parts.join(", ")}`;
};

const writeBackRows = (listing: WriteBackListing): Array<[string, string]> => {
  const files = Object.entries(listing).map(([file, keys]) => writeBackText(file, keys));

  return files.length === 0
    ? [["Written back", "nothing"]]
    : files.map((text, index) => [index === 0 ? "Written back" : "", text]);
};

const sourcesText = (deps: CliDeps, sources: EffectiveConfig["sources"]) => {
  const configured = Object.entries(sources)
    .filter(([, source]) => source !== "default")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, source]) => (source === "config" ? key : `${key} (added to the default)`));

  if (configured.length === 0) {
    return "Every key has its default value.";
  }

  return `${tilde(deps, pathsOf(deps).userConfigFile)} sets ${configured.join(", ")}; every other key has its default value.`;
};

export const configCommand = async (deps: CliDeps) => {
  const { effective } = (await openContext(deps, "host")).context;
  const writeBack = writeBackListing(effective.config.writeBack);

  writeLine(deps.stdout, JSON.stringify(effective.config, null, 2));

  writeLine(deps.stdout, "");

  stepsOf(deps).close(sourcesText(deps, effective.sources), writeBackRows(writeBack));

  return 0;
};
