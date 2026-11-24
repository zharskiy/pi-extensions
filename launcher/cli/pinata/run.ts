import { parseArgs } from "node:util";
import { errorMessage, LauncherError } from "../../shared/index.ts";
import { type CliDeps, writeLines } from "../deps.ts";
import { install } from "./install.ts";
import { uninstall } from "./uninstall.ts";
import { update } from "./update.ts";

const USAGE = [
  "usage:",
  "  pinata install [--pi <version>] [--config <file>] [--yes]",
  "  pinata update [<version>] [--pi <version>]",
  "  pinata uninstall",
];

const OPTIONS = {
  pi: { type: "string" },
  config: { type: "string" },
  yes: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

const parsed = (argv: string[]) => {
  try {
    return parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  } catch (error) {
    throw new LauncherError(errorMessage(error), "pinata --help lists the commands");
  }
};

export const runPinata = async (argv: string[], deps: CliDeps, packageDir: string) => {
  const { values, positionals } = parsed(argv);
  const [command, ...rest] = positionals;

  if (values.help === true || command === undefined) {
    writeLines(deps.stdout, USAGE);

    return 0;
  }

  if (command === "install" && rest.length === 0) {
    return install(deps, packageDir, values);
  }

  if (command === "update" && rest.length <= 1 && values.config === undefined && values.yes === undefined) {
    return update(deps, packageDir, rest[0], values.pi);
  }

  if (command === "uninstall" && rest.length === 0 && Object.keys(values).length === 0) {
    return uninstall(deps, packageDir);
  }

  throw new LauncherError(
    `not a pinata command: pinata ${argv.join(" ")}`,
    "pinata --help lists the commands",
  );
};
