import { setConfigValue } from "../../config/index.ts";
import { LauncherError } from "../../shared/index.ts";
import { type CliDeps, writeLine, writeLines } from "../deps.ts";
import { openContext } from "../launch.ts";

const showConfig = async (deps: CliDeps, json: boolean) => {
  const { effective } = await openContext(deps);

  if (json) {
    writeLine(deps.stdout, JSON.stringify(effective, null, 2));

    return 0;
  }

  const listing = Object.entries(effective.sources)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, layer]) => `# ${key}: ${layer}`);

  writeLines(deps.stdout, [JSON.stringify(effective.config, null, 2), ...listing]);

  return 0;
};

const parseValue = (key: string, text: string) => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new LauncherError(
      `config set ${key}: ${text} is not a JSON value`,
      `quote strings as JSON, for example pi sandbox config set ${key} '"${text}"'`,
    );
  }
};

const setValue = async (deps: CliDeps, args: string[]) => {
  const project = args.includes("--project");
  const [key, text, ...extra] = args.filter((arg) => arg !== "--project");

  if (key === undefined || text === undefined || extra.length > 0) {
    throw new LauncherError("usage: pi sandbox config set <key> <json value> [--project]");
  }

  const value = parseValue(key, text);
  const { workspace } = await openContext(deps);
  const { file } = await setConfigValue({
    layer: project ? "project" : "user",
    key,
    value,
    repoRoot: workspace.repoRoot,
    env: deps.env,
  });

  writeLine(deps.stdout, `set ${key} in ${file}`);

  return 0;
};

export const configCommand = async (deps: CliDeps, args: string[]) => {
  const [action, ...rest] = args;

  if (action === "set") {
    return setValue(deps, rest);
  }

  if (action !== undefined && action !== "--json") {
    throw new LauncherError(`unknown config option "${action}"`, "pi sandbox config [--json] | config set");
  }

  return showConfig(deps, action === "--json");
};
