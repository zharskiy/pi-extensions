import { LauncherError } from "../../shared/index.ts";
import { type CliDeps, isTerminal } from "../deps.ts";
import { isSet } from "../prompt/terminal.ts";
import { runQuietly, type Steps } from "../steps.ts";

export const MAX_FILES_TARGET = 1_048_576;

const SUDO = "/usr/bin/sudo";

const SYSCTL = "/usr/sbin/sysctl";

const LABEL = "local.pinata.maxfiles";

export const BOOT_JOB = `/Library/LaunchDaemons/${LABEL}.plist`;

const READ_TIMEOUT_MS = 10_000;

export const bootJobPlist = (maxFiles: number) => {
  if (!Number.isSafeInteger(maxFiles) || maxFiles < MAX_FILES_TARGET) {
    throw new LauncherError(
      `kern.maxfiles ${maxFiles} is not a whole number of at least ${MAX_FILES_TARGET}`,
    );
  }

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "\t<key>Label</key>",
    `\t<string>${LABEL}</string>`,
    "\t<key>ProgramArguments</key>",
    "\t<array>",
    `\t\t<string>${SYSCTL}</string>`,
    `\t\t<string>kern.maxfiles=${maxFiles}</string>`,
    "\t</array>",
    "\t<key>RunAtLoad</key>",
    "\t<true/>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
};

export const readMaxFiles = async (deps: Pick<CliDeps, "runner" | "home">) => {
  const read = await deps.runner
    .run(SYSCTL, ["-n", "kern.maxfiles"], { cwd: deps.home, timeoutMs: READ_TIMEOUT_MS })
    .catch(() => undefined);
  const text = read?.code === 0 ? read.stdout.trim() : "";

  return /^\d+$/.test(text) ? Number(text) : undefined;
};

const readBootJob = async (deps: CliDeps) => {
  const read = await deps.runner
    .run("/bin/cat", [BOOT_JOB], { cwd: deps.home, timeoutMs: READ_TIMEOUT_MS })
    .catch(() => undefined);

  return read?.code === 0 ? read.stdout : undefined;
};

export const maxFilesNotice = async (deps: CliDeps) => {
  if (deps.platform !== "darwin") {
    return [];
  }

  const current = await readMaxFiles(deps);

  return current === undefined || current >= MAX_FILES_TARGET
    ? []
    : [
        `kern.maxfiles is ${current}, below ${MAX_FILES_TARGET}, so the Mac can run out of open files; run pinata install to raise it`,
      ];
};

const canAsk = (deps: CliDeps, yes: boolean) =>
  isTerminal(deps.terminal.stdin) && !yes && !isSet(deps.env.CI);

interface SudoCommand {
  argv: string[];
  input?: string;
}

const shownCommand = (command: SudoCommand) => command.argv.join(" ");

const runAll = (deps: CliDeps, commands: SudoCommand[]) =>
  commands.reduce(async (previous: Promise<unknown>, command) => {
    await previous;

    return runQuietly(deps, command.argv, { input: command.input });
  }, Promise.resolve<unknown>(undefined));

const failureOf = (error: unknown) => {
  if (error instanceof LauncherError) {
    return error.message;
  }

  throw error;
};

const runWithSudo = async (deps: CliDeps, commands: SudoCommand[]) => {
  const code = await deps.runner.spawnInteractive(SUDO, ["-v"], { cwd: deps.home }).catch(failureOf);

  if (typeof code === "string") {
    return code;
  }

  if (code !== 0) {
    return `sudo exited with code ${code}`;
  }

  return runAll(deps, commands).then(() => undefined, failureOf);
};

const raiseCommands = (current: number, maxFiles: number, installed: string | undefined) => {
  const plist = bootJobPlist(maxFiles);

  return [
    ...(current < maxFiles ? [{ argv: [SUDO, SYSCTL, `kern.maxfiles=${maxFiles}`] }] : []),
    ...(installed === plist
      ? []
      : [
          { argv: [SUDO, "/usr/bin/tee", BOOT_JOB], input: plist },
          { argv: [SUDO, "/bin/chmod", "644", BOOT_JOB] },
        ]),
  ];
};

const raisedText = (current: number, maxFiles: number, jobWritten: boolean) => {
  const raised = `Raised kern.maxfiles from ${current} to ${maxFiles}`;
  const job = `the boot job that sets it at each startup (${BOOT_JOB})`;

  if (current >= maxFiles) {
    return `Installed ${job}`;
  }

  return jobWritten ? `${raised} and installed ${job}` : raised;
};

export const raiseMaxFiles = async (deps: CliDeps, steps: Steps, yes: boolean) => {
  if (deps.platform !== "darwin") {
    return;
  }

  const current = await readMaxFiles(deps);

  if (current === undefined) {
    return steps.warn("Could not read kern.maxfiles, so the Mac's open-file limit stays as it is");
  }

  const maxFiles = Math.max(current, MAX_FILES_TARGET);
  const commands = raiseCommands(current, maxFiles, await readBootJob(deps));

  if (commands.length === 0) {
    return;
  }

  if (!canAsk(deps, yes)) {
    return steps.warn(
      `Skipped raising kern.maxfiles (${current}) to ${maxFiles} with a boot job that keeps it, which needs sudo; run pinata install on a terminal`,
    );
  }

  steps.note(`Raising kern.maxfiles, the Mac's open-file table, to ${maxFiles} runs with sudo:`);

  commands.forEach((command) => {
    steps.note(`  ${shownCommand(command)}`);
  });

  steps.note(`The boot job runs ${SYSCTL} kern.maxfiles=${maxFiles} at each startup.`);

  const failure = await runWithSudo(deps, commands);

  if (failure !== undefined) {
    return steps.warn(`Could not raise kern.maxfiles: ${failure}; run pinata install again`);
  }

  steps.done(
    raisedText(
      current,
      maxFiles,
      commands.some((command) => command.input !== undefined),
    ),
  );
};

export const removeBootJob = async (deps: CliDeps, steps: Steps) => {
  if (deps.platform !== "darwin" || (await readBootJob(deps)) === undefined) {
    return;
  }

  const remove = { argv: [SUDO, "/bin/rm", "-f", BOOT_JOB] };
  const bootout = { argv: [SUDO, "/bin/launchctl", "bootout", `system/${LABEL}`] };

  if (!canAsk(deps, false)) {
    return steps.warn(
      `Left the boot job ${BOOT_JOB}, since removing it needs sudo on a terminal; run ${shownCommand(remove)} and ${shownCommand(bootout)}`,
    );
  }

  steps.note("Removing the boot job that raises kern.maxfiles runs with sudo:");

  [remove, bootout].forEach((command) => {
    steps.note(`  ${shownCommand(command)}`);
  });

  const failure = await runWithSudo(deps, [remove]);

  if (failure !== undefined) {
    return steps.warn(`Could not remove the boot job ${BOOT_JOB}: ${failure}`);
  }

  await runQuietly(deps, bootout.argv).catch(() => undefined);

  const current = await readMaxFiles(deps);

  steps.done(
    `Removed the boot job ${BOOT_JOB}; kern.maxfiles stays at ${current ?? "its raised value"} until the Mac restarts`,
  );
};
