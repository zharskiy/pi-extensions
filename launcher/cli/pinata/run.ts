import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { errorMessage, LauncherError, launcherRoot } from "../../shared/index.ts";
import { configCommand, JSON_FLAG } from "../commands/config.ts";
import { doctorCommand } from "../commands/doctor.ts";
import { VERBOSE_FLAG } from "../commands/doctor-checks.ts";
import { egressCommand } from "../commands/egress.ts";
import { helpCommand, usageOf } from "../commands/help.ts";
import { initCommand, YES_FLAG } from "../commands/init.ts";
import { listCommand } from "../commands/list.ts";
import { assertOptions } from "../commands/options.ts";
import { restartCommand } from "../commands/restart.ts";
import { statusCommand } from "../commands/status.ts";
import { stopCommand } from "../commands/stop.ts";
import { type CliDeps, writeLine } from "../deps.ts";
import { renderFailure } from "../run.ts";
import { launcherVersion } from "../versions.ts";
import { install } from "./install.ts";
import { uninstall } from "./uninstall.ts";
import { update } from "./update.ts";

interface Command {
  run: (deps: CliDeps, args: string[], packageDir: string) => Promise<number> | number;
  options?: string[] | "parsed";
}

const HELP_FLAGS = ["-h", "--help"];

const SANDBOX_FLAG = "--sandbox";

const INSTALL_OPTIONS = { config: { type: "string" }, yes: { type: "boolean" } } as const;

const parseOptions = <T extends Record<string, { type: "string" | "boolean" }>>(
  command: string,
  args: string[],
  options: T,
) => {
  try {
    return parseArgs({ args, options, strict: true, allowPositionals: true });
  } catch (error) {
    throw new LauncherError(`${command}: ${errorMessage(error)}`, usageOf(command));
  }
};

const assertPositionals = (command: string, positionals: string[], most: number) => {
  if (positionals.length > most) {
    throw new LauncherError(`${command}: unexpected argument "${positionals[most]}"`, usageOf(command));
  }
};

const installCommand = (deps: CliDeps, args: string[], packageDir: string) => {
  const { values, positionals } = parseOptions("install", args, INSTALL_OPTIONS);

  assertPositionals("install", positionals, 0);

  return install(deps, packageDir, values);
};

const updateCommand = (deps: CliDeps, args: string[], packageDir: string) => {
  const { positionals } = parseOptions("update", args, {});

  assertPositionals("update", positionals, 1);

  return update(deps, packageDir, positionals[0]);
};

const printVersion = async (deps: CliDeps) => {
  writeLine(deps.stdout, await launcherVersion());

  return 0;
};

const help: Command = { run: helpCommand };

const COMMANDS: Record<string, Command> = {
  install: { run: installCommand, options: "parsed" },
  update: { run: updateCommand, options: "parsed" },
  uninstall: {
    run: (deps, args, packageDir) => uninstall(deps, packageDir, args.includes(SANDBOX_FLAG)),
    options: [SANDBOX_FLAG],
  },
  init: { run: initCommand, options: [YES_FLAG] },
  status: { run: statusCommand, options: [] },
  list: { run: listCommand, options: [] },
  doctor: { run: doctorCommand, options: [VERBOSE_FLAG] },
  config: { run: configCommand, options: [JSON_FLAG] },
  egress: { run: egressCommand },
  restart: { run: restartCommand, options: [] },
  stop: { run: stopCommand, options: [] },
  help,
  "-h": help,
  "--help": help,
  "--version": { run: printVersion },
};

const dispatch = (deps: CliDeps, [name = "help", ...args]: string[], packageDir: string) => {
  const command = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;

  if (command === undefined) {
    throw new LauncherError(`unknown command "pinata ${name}"`, "pinata help");
  }

  if (command.options === undefined) {
    return command.run(deps, args, packageDir);
  }

  if (args.some((arg) => HELP_FLAGS.includes(arg))) {
    writeLine(deps.stdout, `usage: ${usageOf(name)}`);

    return 0;
  }

  if (command.options !== "parsed") {
    assertOptions(name, args, command.options);
  }

  return command.run(deps, args, packageDir);
};

export const runPinata = async (argv: string[], deps: CliDeps, packageDir = dirname(launcherRoot())) => {
  try {
    return await dispatch(deps, argv, packageDir);
  } catch (error) {
    return renderFailure(error, deps.stderr);
  }
};
