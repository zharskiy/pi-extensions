import { errorMessage, LauncherError } from "../shared/index.ts";
import { configCommand, JSON_FLAG } from "./commands/config.ts";
import { doctorCommand } from "./commands/doctor.ts";
import { VERBOSE_FLAG } from "./commands/doctor-checks.ts";
import { EGRESS_ACTIONS } from "./commands/egress.ts";
import { helpCommand, usageOf } from "./commands/help.ts";
import { initCommand, YES_FLAG } from "./commands/init.ts";
import { assertOptions, type Command, isFlag } from "./commands/options.ts";
import { resetCommand } from "./commands/reset.ts";
import { SMOKE_DOCTOR, smokeDoctorCommand } from "./commands/smoke-doctor.ts";
import { statusCommand } from "./commands/status.ts";
import { stopCommand } from "./commands/stop.ts";
import { UNINSTALL, uninstallCommand } from "./commands/uninstall.ts";
import { VM_SHARES, vmSharesCommand } from "./commands/vm-shares.ts";
import { type CliDeps, noticeLine, writeLine } from "./deps.ts";
import { NO_SANDBOX } from "./host-pi.ts";
import { intercept } from "./intercept.ts";
import { launch } from "./launch.ts";
import { launcherVersion } from "./versions.ts";

const UNEXPECTED_EXIT = 70;

const printVersion = async (deps: CliDeps) => {
  writeLine(deps.stdout, await launcherVersion());

  return 0;
};

const help: Command = { run: helpCommand };

const COMMANDS: Record<string, Command> = {
  init: { run: initCommand, options: [YES_FLAG] },
  status: { run: statusCommand, options: [] },
  doctor: { run: doctorCommand, options: [VERBOSE_FLAG] },
  config: { run: configCommand, options: [JSON_FLAG] },
  egress: { actions: EGRESS_ACTIONS },
  reset: { run: resetCommand, options: [] },
  stop: { run: stopCommand, options: [] },
  help,
  "--help": help,
  "--version": { run: printVersion },
};

const HIDDEN: Record<string, (deps: CliDeps) => Promise<number>> = {
  [UNINSTALL]: uninstallCommand,
  [VM_SHARES]: vmSharesCommand,
  [SMOKE_DOCTOR]: smokeDoctorCommand,
};

const HELP_FLAGS = ["-h", "--help"];

const printUsage = (deps: CliDeps, name: string) => {
  writeLine(deps.stdout, `usage: ${usageOf(name)}`);

  return 0;
};

const runCommand = (
  deps: CliDeps,
  name: string,
  command: Command,
  args: string[],
): Promise<number> | number => {
  if ("actions" in command) {
    const [action = "", ...rest] = args;

    if (HELP_FLAGS.includes(action)) {
      return printUsage(deps, name);
    }

    const chosen = Object.hasOwn(command.actions, action) ? command.actions[action] : undefined;

    if (chosen === undefined) {
      throw new LauncherError(`unknown ${name} action "${action}"`, usageOf(name));
    }

    return runCommand(deps, `${name} ${action}`, chosen, rest);
  }

  if (command.options === undefined) {
    return command.run(deps, args);
  }

  if (args.some((arg) => HELP_FLAGS.includes(arg))) {
    return printUsage(deps, name);
  }

  assertOptions(name, command.operands === true ? args.filter(isFlag) : args, command.options);

  return command.run(deps, args);
};

const sandbox = (deps: CliDeps, [name = "help", ...args]: string[]) => {
  const command = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;

  if (command === undefined) {
    throw new LauncherError(`unknown command "pi sandbox ${name}"`, "pi sandbox help");
  }

  return runCommand(deps, name, command, args);
};

const route = async (argv: string[], deps: CliDeps) => {
  const [first = "", ...rest] = argv;

  if (first === "sandbox") {
    return sandbox(deps, rest);
  }

  const hidden = rest.length === 0 && Object.hasOwn(HIDDEN, first) ? HIDDEN[first] : undefined;

  if (hidden !== undefined) {
    return hidden(deps);
  }

  const intercepted = argv.includes(NO_SANDBOX) ? undefined : await intercept(argv, deps);

  return intercepted ?? launch(argv, deps);
};

export const renderFailure = (error: unknown, stderr: NodeJS.WritableStream) => {
  if (error instanceof LauncherError) {
    writeLine(stderr, noticeLine(error.message));

    if (error.hint !== undefined) {
      writeLine(stderr, `  hint: ${error.hint}`);
    }

    return error.exitCode ?? 1;
  }

  writeLine(stderr, noticeLine(`unexpected error: ${errorMessage(error)}`));

  return UNEXPECTED_EXIT;
};

export const run = async (argv: string[], deps: CliDeps) => {
  try {
    return await route(argv, deps);
  } catch (error) {
    return renderFailure(error, deps.stderr);
  }
};
