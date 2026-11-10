import { errorMessage, LauncherError } from "../shared/index.ts";
import { configCommand, JSON_FLAG } from "./commands/config.ts";
import { doctorCommand } from "./commands/doctor.ts";
import { egressCommand } from "./commands/egress.ts";
import { gcCommand, SHARED_CACHES } from "./commands/gc.ts";
import { helpCommand } from "./commands/help.ts";
import { assertOptions } from "./commands/options.ts";
import { resetCommand, VOLUMES } from "./commands/reset.ts";
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
}

const printVersion = async (deps: CliDeps) => {
  writeLine(deps.stdout, await launcherVersion());

  return 0;
};

const help: Command = { run: helpCommand };

const version: Command = { run: printVersion };

const COMMANDS: Record<string, Command> = {
  status: { run: statusCommand, options: [] },
  gc: { run: gcCommand, options: [SHARED_CACHES] },
  doctor: { run: doctorCommand, options: [] },
  config: { run: configCommand, options: [JSON_FLAG] },
  egress: { run: egressCommand },
  reset: { run: resetCommand, options: [VOLUMES] },
  stop: { run: stopCommand, options: [] },
  help,
  "--help": help,
  "-h": help,
  "--version": version,
  "-v": version,
};

const sandbox = (deps: CliDeps, [name = "help", ...args]: string[]) => {
  const command = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;

  if (command === undefined) {
    throw new LauncherError(`unknown command "pi sandbox ${name}"`, "pi sandbox help");
  }

  if (command.options?.length === 0 && args.length > 0) {
    throw new LauncherError(`pi sandbox ${name} takes no arguments`, "pi sandbox help");
  }

  if (command.options !== undefined) {
    assertOptions(name, args, command.options);
  }

  return command.run(deps, args);
};

const route = (argv: string[], deps: CliDeps) => {
  const [first, ...rest] = argv;

  if (first === "sandbox") {
    return sandbox(deps, rest);
  }

  return (argv.includes("--no-sandbox") ? undefined : intercept(argv, deps)) ?? launch(argv, deps);
};

export const renderFailure = (error: unknown, stderr: NodeJS.WritableStream) => {
  if (error instanceof LauncherError) {
    writeLine(stderr, `pi-sandbox: ${error.message}`);

    if (error.hint !== undefined) {
      writeLine(stderr, `  hint: ${error.hint}`);
    }

    return 1;
  }

  writeLine(stderr, `pi-sandbox: unexpected error: ${errorMessage(error)}`);

  return UNEXPECTED_EXIT;
};

export const run = async (argv: string[], deps: CliDeps) => {
  try {
    return await route(argv, deps);
  } catch (error) {
    return renderFailure(error, deps.stderr);
  }
};
