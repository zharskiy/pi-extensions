import { errorMessage, LauncherError } from "../shared/index.ts";
import { configCommand, JSON_FLAG } from "./commands/config.ts";
import { doctorCommand } from "./commands/doctor.ts";
import { VERBOSE_FLAG } from "./commands/doctor-checks.ts";
import { egressCommand } from "./commands/egress.ts";
import { helpCommand, usageOf } from "./commands/help.ts";
import { initCommand, YES_FLAG } from "./commands/init.ts";
import { listCommand } from "./commands/list.ts";
import { assertOptions } from "./commands/options.ts";
import { RESTART_OPTIONS_HINT, restartCommand } from "./commands/restart.ts";
import { statusCommand } from "./commands/status.ts";
import { stopCommand } from "./commands/stop.ts";
import { type CliDeps, writeLine } from "./deps.ts";
import { intercept } from "./intercept.ts";
import { launch } from "./launch.ts";
import { launcherVersion } from "./versions.ts";

const UNEXPECTED_EXIT = 70;

interface Command {
  run: (deps: CliDeps, args: string[]) => Promise<number> | number;
  options?: string[];
  optionsHint?: string;
}

const printVersion = async (deps: CliDeps) => {
  writeLine(deps.stdout, await launcherVersion());

  return 0;
};

const help: Command = { run: helpCommand };

const COMMANDS: Record<string, Command> = {
  init: { run: initCommand, options: [YES_FLAG] },
  status: { run: statusCommand, options: [] },
  list: { run: listCommand, options: [] },
  doctor: { run: doctorCommand, options: [VERBOSE_FLAG] },
  config: { run: configCommand, options: [JSON_FLAG] },
  egress: { run: egressCommand },
  restart: { run: restartCommand, options: [], optionsHint: RESTART_OPTIONS_HINT },
  stop: { run: stopCommand, options: [] },
  help,
  "--help": help,
  "--version": { run: printVersion },
};

const RENAMED: Record<string, string> = { reset: "restart" };

const HELP_FLAGS = ["-h", "--help"];

const unknownCommandHint = (name: string) =>
  Object.hasOwn(RENAMED, name) ? `pi sandbox ${name} is now pi sandbox ${RENAMED[name]}` : "pi sandbox help";

const sandbox = (deps: CliDeps, [name = "help", ...args]: string[]) => {
  const command = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;

  if (command === undefined) {
    throw new LauncherError(`unknown command "pi sandbox ${name}"`, unknownCommandHint(name));
  }

  if (command.options === undefined) {
    return command.run(deps, args);
  }

  if (args.some((arg) => HELP_FLAGS.includes(arg))) {
    writeLine(deps.stdout, `usage: ${usageOf(name)}`);

    return 0;
  }

  assertOptions(name, args, command.options, command.optionsHint);

  return command.run(deps, args);
};

const route = async (argv: string[], deps: CliDeps) => {
  const [first, ...rest] = argv;

  if (first === "sandbox") {
    return sandbox(deps, rest);
  }

  const intercepted = argv.includes("--no-sandbox") ? undefined : await intercept(argv, deps);

  return intercepted ?? launch(argv, deps);
};

export const renderFailure = (error: unknown, stderr: NodeJS.WritableStream, name = "pi-sandbox") => {
  if (error instanceof LauncherError) {
    writeLine(stderr, `${name}: ${error.message}`);

    if (error.hint !== undefined) {
      writeLine(stderr, `  hint: ${error.hint}`);
    }

    return 1;
  }

  writeLine(stderr, `${name}: unexpected error: ${errorMessage(error)}`);

  return UNEXPECTED_EXIT;
};

export const run = async (argv: string[], deps: CliDeps) => {
  try {
    return await route(argv, deps);
  } catch (error) {
    return renderFailure(error, deps.stderr);
  }
};
