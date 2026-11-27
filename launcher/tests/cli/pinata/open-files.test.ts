import { writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { VmInspect } from "../../../backend/index.ts";
import { run } from "../../../cli/index.ts";
import { BOOT_JOB, bootJobPlist, MAX_FILES_TARGET } from "../../../cli/pinata/open-files.ts";
import { stateLayout } from "../../../shared/index.ts";
import { argvOf } from "../../support/fake-runner.ts";
import { createFakeBackend, createHarness } from "../harness.ts";
import { createPinata } from "./support.ts";

const RUNNING: VmInspect = { state: "running", size: { cpus: 4, memoryGiB: 8, diskGiB: 60 }, shares: [] };

const RAISE = [
  "/usr/bin/sudo -v",
  "/usr/bin/sudo /usr/sbin/sysctl kern.maxfiles=1048576",
  `/usr/bin/sudo /usr/bin/tee ${BOOT_JOB}`,
  `/usr/bin/sudo /bin/chmod 644 ${BOOT_JOB}`,
];

const REMOVE = [
  "/usr/bin/sudo -v",
  `/usr/bin/sudo /bin/rm -f ${BOOT_JOB}`,
  "/usr/bin/sudo /bin/launchctl bootout system/local.pinata.maxfiles",
];

type Pinata = Awaited<ReturnType<typeof createPinata>>;

const onTerminal = (pinata: Pinata) => {
  Object.assign(pinata.harness.deps.terminal.stdin, { isTTY: true });

  return pinata;
};

const installed = async (tty: boolean) => {
  const pinata = await createPinata({ vm: { inspect: async () => RUNNING } });

  await writeFile(stateLayout(pinata.harness.stateDir).salt, "salt");

  Object.assign(pinata.harness.deps.terminal.stdin, { isTTY: tty });

  return pinata;
};

const sudoLines = (pinata: Pinata) => pinata.lines().filter((line) => line.startsWith("/usr/bin/sudo"));

describe("the boot job plist", () => {
  it("runs only /usr/sbin/sysctl with the value, at load", () => {
    const plist = bootJobPlist(2_000_000);

    expect(plist).toContain("<string>local.pinata.maxfiles</string>");
    expect(plist).toContain("<string>/usr/sbin/sysctl</string>\n\t\t<string>kern.maxfiles=2000000</string>");
    expect(plist).toContain("<key>RunAtLoad</key>\n\t<true/>");
    expect(plist.match(/<string>\//g)).toHaveLength(1);
    expect(plist).not.toContain("maxfilesperproc");
  });

  it("refuses a value below the target or not a whole number", () => {
    expect(() => bootJobPlist(MAX_FILES_TARGET - 1)).toThrow("is not a whole number of at least");
    expect(() => bootJobPlist(Number.NaN)).toThrow("is not a whole number of at least");
  });
});

describe("pinata install and the open-file limit", () => {
  it("shows the fixed commands and runs them with sudo on a terminal", async () => {
    const pinata = onTerminal(
      await createPinata({ maxFiles: 122880, bootJob: false, vm: { inspect: async () => RUNNING } }),
    );

    expect(await pinata.run("install")).toBe(0);
    expect(sudoLines(pinata)).toEqual(RAISE);
    expect(pinata.harness.calls.find((call) => argvOf(call).includes("/usr/bin/tee"))?.options.input).toBe(
      bootJobPlist(MAX_FILES_TARGET),
    );
    expect(pinata.harness.stdout()).toContain(
      [
        "Raising kern.maxfiles, the Mac's open-file table, to 1048576 runs with sudo:",
        ...RAISE.slice(1).map((line) => `  ${line}`),
        "The boot job runs /usr/sbin/sysctl kern.maxfiles=1048576 at each startup.",
      ].join("\n"),
    );
    expect(pinata.harness.stdout()).toContain(
      `ok Raised kern.maxfiles from 122880 to 1048576 and installed the boot job that sets it at each startup (${BOOT_JOB})`,
    );
    expect(pinata.mac).toEqual({ maxFiles: MAX_FILES_TARGET, bootJob: bootJobPlist(MAX_FILES_TARGET) });
    expect(pinata.lines().join("\n")).not.toContain("maxfilesperproc");
  });

  it("keeps a larger value and writes it into the boot job without a sysctl write", async () => {
    const pinata = onTerminal(await createPinata({ maxFiles: 2_000_000, bootJob: false }));

    expect(await pinata.run("install")).toBe(0);
    expect(sudoLines(pinata)).toEqual(["/usr/bin/sudo -v", ...RAISE.slice(2)]);
    expect(pinata.mac).toEqual({ maxFiles: 2_000_000, bootJob: bootJobPlist(2_000_000) });
  });

  it("asks for nothing when the value and the boot job are already right", async () => {
    const pinata = onTerminal(await createPinata());

    expect(await pinata.run("install")).toBe(0);
    expect(sudoLines(pinata)).toEqual([]);
    expect(pinata.harness.stdout()).not.toContain("kern.maxfiles");
  });

  it.each([
    ["off a terminal", [], {}, false],
    ["with --yes", ["--yes"], {}, true],
    ["under CI", [], { CI: "true" }, true],
  ])("skips the step with one line %s, and the install still succeeds", async (_, flags, env, tty) => {
    const pinata = await createPinata({ maxFiles: 122880, bootJob: false, env });

    Object.assign(pinata.harness.deps.terminal.stdin, { isTTY: tty });

    expect(await pinata.run("install", ...flags)).toBe(0);
    expect(sudoLines(pinata)).toEqual([]);
    expect(pinata.harness.stdout()).toContain(
      "! Skipped raising kern.maxfiles (122880) to 1048576 with a boot job that keeps it, which needs sudo; run pinata install on a terminal\n",
    );
    expect(pinata.mac.maxFiles).toBe(122880);
  });

  it("warns and finishes the install when sudo is refused", async () => {
    const pinata = onTerminal(
      await createPinata({
        maxFiles: 122880,
        bootJob: false,
        answer: (call) => (argvOf(call).join(" ") === "/usr/bin/sudo -v" ? { code: 1 } : undefined),
      }),
    );

    expect(await pinata.run("install")).toBe(0);
    expect(sudoLines(pinata)).toEqual(["/usr/bin/sudo -v"]);
    expect(pinata.harness.stdout()).toContain(
      "! Could not raise kern.maxfiles: sudo exited with code 1; run pinata install again\n",
    );
  });

  it("does nothing on a host other than macOS", async () => {
    const pinata = onTerminal(await createPinata({ maxFiles: 122880, bootJob: false }));

    Object.assign(pinata.harness.deps, { platform: "linux" });

    expect(await pinata.run("install")).toBe(0);
    expect(pinata.lines().filter((line) => line.includes("kern.maxfiles"))).toEqual([]);
  });
});

describe("pinata uninstall and the boot job", () => {
  it("removes the boot job with sudo and says the value stays until a restart", async () => {
    const pinata = await installed(true);

    expect(await pinata.run("uninstall")).toBe(0);
    expect(sudoLines(pinata)).toEqual(REMOVE);
    expect(pinata.mac.bootJob).toBeUndefined();
    expect(pinata.harness.stdout()).toContain(
      `ok Removed the boot job ${BOOT_JOB}; kern.maxfiles stays at 1048576 until the Mac restarts\n`,
    );
  });

  it("keeps the boot job with --sandbox", async () => {
    const pinata = await installed(true);

    expect(await pinata.run("uninstall", "--sandbox")).toBe(0);
    expect(sudoLines(pinata)).toEqual([]);
    expect(pinata.mac.bootJob).toBe(bootJobPlist(MAX_FILES_TARGET));
  });

  it("leaves the boot job off a terminal and prints the commands to run", async () => {
    const pinata = await installed(false);

    expect(await pinata.run("uninstall")).toBe(0);
    expect(sudoLines(pinata)).toEqual([]);
    expect(pinata.harness.stdout()).toContain(`run ${REMOVE[1]} and ${REMOVE[2]}\n`);
  });
});

describe("a launch and the open-file limit", () => {
  it.each([
    [122880, true],
    [MAX_FILES_TARGET, false],
  ])("reads kern.maxfiles %s and says to run pinata install only when it is low", async (value, low) => {
    const fake = createFakeBackend({});
    const harness = await createHarness({
      backend: () => fake.backend,
      respond: (call) => (call.file === "/usr/sbin/sysctl" ? { stdout: `${value}\n` } : undefined),
    });

    await run(["--model", "x"], harness.deps);

    expect(harness.stderr().includes(`pinata: kern.maxfiles is ${value}, below 1048576`)).toBe(low);
    expect(harness.stderr()).not.toContain("run pinata install to raise it\n".repeat(2));
    expect(harness.calls.some((call) => call.file === "/usr/bin/sudo")).toBe(false);
  });
});
