import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LABELS, type Vm } from "../../../backend/index.ts";
import { BOOT_JOB, bootJobPlist, MAX_FILES_TARGET } from "../../../cli/pinata/open-files.ts";
import { runPinata } from "../../../cli/pinata/run.ts";
import { argvOf, type FakeAnswer, type FakeCall } from "../../support/fake-runner.ts";
import { createFakeBackend, createHarness, type HarnessOptions } from "../harness.ts";

const ANSWERS: Record<string, string> = {
  "brew --version": "Homebrew 4.4.0",
  "colima version": "colima version 0.10.3",
  "colima delete --profile pinata --force --data": "",
};

const GLOBAL_NPM = /^npm (install|uninstall) -g /;

interface PinataOptions extends HarnessOptions {
  global?: boolean;
  vm?: Partial<Vm>;
  answer?: (call: FakeCall) => FakeAnswer | undefined;
  maxFiles?: number;
  bootJob?: string | false;
}

interface FakeMac {
  maxFiles: number;
  bootJob?: string;
}

const macAnswer = (mac: FakeMac, call: FakeCall): FakeAnswer => {
  const [first = "", ...rest] = call.args;
  const sudo = call.file === "/usr/bin/sudo" ? [first, ...rest].join(" ") : undefined;

  if (call.file === "/usr/sbin/sysctl" && call.args.join(" ") === "-n kern.maxfiles") {
    return { stdout: `${mac.maxFiles}\n` };
  }

  if (call.file === "/bin/cat" && first === BOOT_JOB) {
    return mac.bootJob === undefined
      ? { code: 1, stderr: "No such file or directory\n" }
      : { stdout: mac.bootJob };
  }

  if (sudo?.startsWith("/usr/sbin/sysctl kern.maxfiles=")) {
    mac.maxFiles = Number(sudo.split("=")[1]);

    return { stdout: "" };
  }

  if (sudo === `/usr/bin/tee ${BOOT_JOB}`) {
    mac.bootJob = call.options.input;

    return { stdout: call.options.input };
  }

  if (sudo === `/bin/rm -f ${BOOT_JOB}`) {
    mac.bootJob = undefined;

    return {};
  }

  return sudo === undefined ? undefined : {};
};

export const writePackages = async (agentDir: string, packages: string[]) => {
  await mkdir(agentDir, { recursive: true });

  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages }));
};

export const createPinata = async (options: PinataOptions = {}) => {
  const fake = createFakeBackend({ vm: { inspect: async () => ({ state: "absent" }), ...options.vm } });
  const maxFiles = options.maxFiles ?? MAX_FILES_TARGET;
  const mac: FakeMac = {
    maxFiles,
    bootJob:
      options.bootJob === false
        ? undefined
        : (options.bootJob ?? bootJobPlist(Math.max(maxFiles, MAX_FILES_TARGET))),
  };
  const harness = await createHarness({
    backend: () => fake.backend,
    ...options,
    respond: (call) => {
      const line = argvOf(call).join(" ");
      const [command = "", source = ""] = call.args;

      if (call.file.endsWith("/bin/pi") && ["install", "remove"].includes(command)) {
        return packages()
          .then((list) =>
            writePackages(harness.hostAgentDir, [
              ...list.filter((entry) => entry !== source),
              ...(command === "install" ? [source] : []),
            ]),
          )
          .then(() => ({ code: 0 }));
      }

      return (
        options.answer?.(call) ??
        macAnswer(mac, call) ??
        (line === "npm prefix -g"
          ? { stdout: `${prefix}\n` }
          : GLOBAL_NPM.test(line)
            ? {}
            : ANSWERS[line] === undefined
              ? undefined
              : { stdout: `${ANSWERS[line]}\n` })
      );
    },
  });
  const prefix = join(harness.root, "npm");
  const packageDir = options.global
    ? join(prefix, "lib", "node_modules", "@zharskiy", "pinata")
    : join(harness.root, "pinata");
  const packages = async (): Promise<string[]> =>
    JSON.parse(await readFile(join(harness.hostAgentDir, "settings.json"), "utf8").catch(() => "{}"))
      .packages ?? [];
  const busy = () =>
    fake.addContainer({
      name: "other",
      labels: { [LABELS.managed]: "true", [LABELS.install]: "other", [LABELS.role]: "agent" },
      state: "running",
      image: "x",
    });

  await mkdir(options.global ? packageDir : join(packageDir, ".git"), { recursive: true });

  return {
    harness,
    fake,
    mac,
    packageDir,
    packages,
    busy,
    home: join(harness.root, "home"),
    shim: join(harness.root, "home", ".local", "bin", "pi"),
    run: (...argv: string[]) => runPinata(argv, harness.deps, packageDir),
    lines: () => harness.calls.map((call) => argvOf(call).join(" ")),
  };
};
