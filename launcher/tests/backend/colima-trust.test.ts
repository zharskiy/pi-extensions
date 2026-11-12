import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createColimaVm } from "../../backend/colima/vm.ts";
import { sha256Hex } from "../../shared/index.ts";
import { createFakeRunner, type FakeCall } from "../support/fake-runner.ts";
import { tempDir, writeText } from "../support/temp-dir.ts";

interface VmState {
  marker?: string;
  failing?: string;
  sshDown?: boolean;
  restartHangs?: boolean;
  engineUpAfter?: number;
}

const SSH = ["ssh", "--profile", "pi-sandbox", "--"];

const MARKER = "/etc/pi-sandbox/extra.sha256";

const CERT_DIR = "/usr/local/share/ca-certificates/pi-sandbox";

const certificate = (body: string) => `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`;

const FIRST = certificate("QUFBQQ==");

const SECOND = certificate("QkJCQg==");

const commandOf = (call: FakeCall) => call.args.slice(SSH.length).join(" ");

const setup = async (state: VmState, busy = 0) => {
  const stateDir = await tempDir("trust");
  const pemPath = join(stateDir, "ca", "extra.pem");
  const notices: string[] = [];
  const pauses: number[] = [];
  const detections = { count: 0 };
  const respond = (call: FakeCall) => {
    const command = commandOf(call);

    if (state.sshDown === true && command === `cat ${MARKER}`) {
      return { code: 255, stderr: "ssh: connect to host 127.0.0.1 port 51234: Connection refused" };
    }

    if (state.restartHangs === true && command.startsWith("sudo systemctl restart")) {
      return { code: 124, timedOut: true as const };
    }

    if (state.failing !== undefined && command.startsWith(state.failing)) {
      return { code: 1, stderr: "update-ca-certificates: boom" };
    }

    if (command === `cat ${MARKER}`) {
      return state.marker === undefined
        ? { code: 1, stderr: `cat: ${MARKER}: No such file or directory` }
        : { stdout: state.marker };
    }

    if (command === `sudo tee -- ${MARKER}`) {
      state.marker = call.options.input;
    }

    if (command.startsWith(`sudo rm -`) && command.includes(MARKER)) {
      state.marker = undefined;
    }

    return {};
  };
  const fake = createFakeRunner((call) => (call.file === "colima" ? respond(call) : undefined));
  const vm = createColimaVm({
    home: stateDir,
    stateDir,
    runner: fake.runner,
    detect: async () => {
      detections.count += 1;

      return detections.count > (state.engineUpAfter ?? 0)
        ? { available: true }
        : { available: false, reason: "engine socket refused" };
    },
    pause: async (ms) => {
      pauses.push(ms);
    },
  });
  const ensure = () =>
    vm.ensureTrust(pemPath, { busy: async () => busy, report: (notice) => notices.push(notice) });

  return {
    pemPath,
    notices,
    pauses,
    ensure,
    commands: () => fake.calls.map(commandOf),
    inputs: () =>
      fake.calls.flatMap((call) => (call.options.input === undefined ? [] : [call.options.input])),
    calls: fake.calls,
  };
};

describe("the sandbox VM trusts the tls.extraCa certificates", () => {
  it("checks the marker only when the bundle has not changed", async () => {
    const state = { marker: `${sha256Hex(FIRST)}\n` };
    const context = await setup(state);

    await writeText(context.pemPath, FIRST);

    await context.ensure();

    expect(context.commands()).toEqual([`cat ${MARKER}`]);

    expect(context.notices).toEqual([]);
  });

  it("checks once and changes nothing when there is no bundle and no marker", async () => {
    const context = await setup({});

    await context.ensure();

    expect(context.commands()).toEqual([`cat ${MARKER}`]);
  });

  it("installs a changed bundle, refreshes the store, restarts the engine and writes the marker once the restart ran", async () => {
    const state: VmState = { marker: "old\n" };
    const context = await setup(state);

    await writeText(context.pemPath, FIRST);

    await context.ensure();

    expect(context.commands()).toEqual([
      `cat ${MARKER}`,
      `cat ${MARKER}`,
      `sudo rm -rf -- ${MARKER} ${CERT_DIR}`,
      `sudo mkdir -p -- ${CERT_DIR} /etc/pi-sandbox`,
      `sudo tee -- ${CERT_DIR}/pi-sandbox-extra-1.crt`,
      "sudo update-ca-certificates --fresh",
      "sudo systemctl restart containerd.service docker.service",
      `sudo tee -- ${MARKER}`,
    ]);

    expect(context.inputs()).toEqual([FIRST, `${sha256Hex(FIRST)}\n`]);

    expect(state.marker).toBe(`${sha256Hex(FIRST)}\n`);

    expect(context.calls.every((call) => call.file === "colima" && call.args[0] === "ssh")).toBe(true);
  });

  it("delivers the certificates on stdin, never in the command", async () => {
    const context = await setup({});

    await writeText(context.pemPath, FIRST);

    await context.ensure();

    expect(context.calls.some((call) => call.args.join(" ").includes("BEGIN CERTIFICATE"))).toBe(false);
  });

  it("writes each certificate of a bundle to its own file", async () => {
    const context = await setup({});

    await writeText(context.pemPath, `${FIRST}\n${SECOND}`);

    await context.ensure();

    expect(context.commands().filter((command) => command.startsWith("sudo tee"))).toEqual([
      `sudo tee -- ${CERT_DIR}/pi-sandbox-extra-1.crt`,
      `sudo tee -- ${CERT_DIR}/pi-sandbox-extra-2.crt`,
      `sudo tee -- ${MARKER}`,
    ]);

    expect(context.inputs()).toEqual([FIRST, SECOND, `${sha256Hex(FIRST + SECOND)}\n`]);
  });

  it("removes the certificates and the marker when the bundle is emptied", async () => {
    const state: VmState = { marker: "old\n" };
    const context = await setup(state);

    await writeText(context.pemPath, "");

    await context.ensure();

    expect(context.commands()).toEqual([
      `cat ${MARKER}`,
      `cat ${MARKER}`,
      `sudo rm -rf -- ${CERT_DIR}`,
      "sudo update-ca-certificates --fresh",
      "sudo systemctl restart containerd.service docker.service",
      `sudo rm -f -- ${MARKER}`,
    ]);

    expect(state.marker).toBeUndefined();
  });

  it("defers the change with one notice while another pi session is live", async () => {
    const state: VmState = { marker: "old\n" };
    const context = await setup(state, 1);

    await writeText(context.pemPath, FIRST);

    await context.ensure();

    expect(context.commands()).toEqual([`cat ${MARKER}`, `cat ${MARKER}`]);

    expect(context.notices).toEqual([
      "the sandbox VM will pick up the tls.extraCa certificate change at the first launch with no other pi session running",
    ]);

    expect(state.marker).toBe("old\n");
  });

  it("takes the locked path and reinstalls when the marker cannot be read over ssh", async () => {
    const state: VmState = { sshDown: true };
    const context = await setup(state);

    await context.ensure();

    expect(context.commands()).toEqual([
      `cat ${MARKER}`,
      `cat ${MARKER}`,
      `sudo rm -rf -- ${CERT_DIR}`,
      "sudo update-ca-certificates --fresh",
      "sudo systemctl restart containerd.service docker.service",
      `sudo rm -f -- ${MARKER}`,
    ]);
  });

  it("puts a timeout on the engine restart and leaves no marker when it hangs", async () => {
    const state: VmState = { marker: "old\n", restartHangs: true };
    const context = await setup(state);

    await writeText(context.pemPath, FIRST);

    const failure = await context.ensure().catch((error: unknown) => error as Error);
    const restart = context.calls.find((call) => commandOf(call).startsWith("sudo systemctl restart"));

    expect(failure?.message).toBe(
      "could not install the tls.extraCa certificates in the sandbox VM: systemctl restart containerd.service docker.service did not finish within 60 s",
    );

    expect(restart?.options.timeoutMs).toBe(60_000);

    expect(state.marker).toBeUndefined();
  });

  it("waits up to a minute for a slow engine after the restart", async () => {
    const state: VmState = { engineUpAfter: 30 };
    const context = await setup(state);

    await writeText(context.pemPath, FIRST);

    await context.ensure();

    expect(context.pauses).toHaveLength(31);

    expect(state.marker).toBe(`${sha256Hex(FIRST)}\n`);
  });

  it("keeps the marker when the engine is still down after a minute, so the next launch does not reinstall", async () => {
    const state: VmState = { engineUpAfter: 1000 };
    const context = await setup(state);

    await writeText(context.pemPath, FIRST);

    const failure = await context.ensure().catch((error: unknown) => error as Error);

    expect(failure?.message).toBe(
      "the sandbox VM engine did not come back after installing the tls.extraCa certificates: engine socket refused",
    );

    expect(context.pauses.reduce((total, ms) => total + ms, 0)).toBe(59_000);

    expect(state.marker).toBe(`${sha256Hex(FIRST)}\n`);

    const again = await setup(state);

    await writeText(again.pemPath, FIRST);

    await again.ensure();

    expect(again.commands()).toEqual([`cat ${MARKER}`]);
  });

  it("fails clearly and leaves no marker when a VM command fails", async () => {
    const state: VmState = { marker: "old\n", failing: "sudo update-ca-certificates" };
    const context = await setup(state);

    await writeText(context.pemPath, FIRST);

    const failure = await context.ensure().catch((error: unknown) => error as Error);

    expect(failure?.message).toBe(
      "could not install the tls.extraCa certificates in the sandbox VM: update-ca-certificates --fresh failed: update-ca-certificates: boom",
    );

    expect(state.marker).toBeUndefined();

    expect(context.commands()).not.toContain(`sudo tee -- ${MARKER}`);
  });
});
