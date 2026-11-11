export type HostRoute = { kind: "version" } | { kind: "empty-dir" | "cwd"; args: string[] };

const HELP_FLAGS = ["--help", "-h"];

const VERSION_FLAGS = ["--version", "-v"];

const NO_RESOURCES = ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--offline"];

const HELP_COMMANDS = new Set(["install", "remove", "uninstall", "update", "list", "config"]);

const isHelpFlag = (arg: string) => HELP_FLAGS.includes(arg);

const isValue = (arg: string) => !arg.startsWith("-") && !arg.startsWith("@");

const isMcpHelp = (args: string[]) => args.length === 0 || args[0] === "help" || args.some(isHelpFlag);

const isSubcommandHelp = (command: string, args: string[]) =>
  (HELP_COMMANDS.has(command) && args.some(isHelpFlag)) || (command === "mcp" && isMcpHelp(args));

const isListModels = ([flag, search, ...extra]: string[]) =>
  flag === "--list-models" && (search === undefined || isValue(search)) && extra.length === 0;

const isExport = ([flag, file, output, ...extra]: string[]) =>
  flag === "--export" &&
  file !== undefined &&
  !file.startsWith("-") &&
  (output === undefined || isValue(output)) &&
  extra.length === 0;

const onlyFlag = (argv: string[], flags: string[]) => argv.length === 1 && flags.includes(argv[0] ?? "");

const topLevelRoute = (argv: string[]): HostRoute | undefined => {
  if (onlyFlag(argv, VERSION_FLAGS)) {
    return { kind: "version" };
  }

  if (onlyFlag(argv, HELP_FLAGS) || isListModels(argv)) {
    return { kind: "empty-dir", args: [...argv, ...NO_RESOURCES] };
  }

  return isExport(argv) ? { kind: "cwd", args: argv } : undefined;
};

export const hostRoute = (argv: string[]): HostRoute | undefined => {
  const [command = "", ...args] = argv;

  if (command === "auth" || isSubcommandHelp(command, args)) {
    return { kind: "empty-dir", args: argv };
  }

  return topLevelRoute(argv);
};
