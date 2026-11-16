import { readFile } from "node:fs/promises";
import { errorMessage, LauncherError, type RunResult, sha256Hex } from "../../shared/index.ts";
import type { VmShareOptions } from "../types.ts";
import { type Colima, logHint } from "./profile.ts";

interface ShellOptions {
  input?: string;
  timeoutMs?: number;
}

type VmShell = (command: string[], options?: ShellOptions) => Promise<RunResult>;

const CERT_DIR = "/usr/local/share/ca-certificates/pi-sandbox";

const MARKER_DIR = "/etc/pi-sandbox";

const MARKER = `${MARKER_DIR}/extra.sha256`;

const ENGINE_SERVICES = ["containerd.service", "docker.service"];

const RESTART_TIMEOUT_MS = 60_000;

const ENGINE_RESTART_DELAYS_MS = [0, ...Array.from({ length: 59 }, () => 1000)];

const MISSING_FILE = "No such file or directory";

const PEM_BLOCK = /-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\s]+-----END CERTIFICATE-----/g;

const FAILURE = "could not install the tls.extraCa certificates in the sandbox VM";

const DEFERRED =
  "the sandbox VM will pick up the tls.extraCa certificate change at the first launch with no other pi session running";

const certificatesIn = (text: string) => (text.match(PEM_BLOCK) ?? []).map((pem) => `${pem.trim()}\n`);

const certPath = (index: number) => `${CERT_DIR}/pi-sandbox-extra-${index + 1}.crt`;

const lastLine = (text: string) => text.trim().split("\n").at(-1) ?? "";

export const createColimaTrust = (colima: Colima, shell: VmShell) => {
  const step = async (command: string[], options: ShellOptions = {}) => {
    const result = await shell(["sudo", ...command], options).catch((error: unknown) => {
      throw new LauncherError(`${FAILURE}: ${errorMessage(error)}`, `see ${logHint(colima.profile)}`);
    });

    if (result.timedOut === true) {
      throw new LauncherError(
        `${FAILURE}: ${command.join(" ")} did not finish within ${(options.timeoutMs ?? 0) / 1000} s`,
        `run colima ssh --profile ${colima.profile} -- sudo ${command.join(" ")} to see why, then run pi again`,
      );
    }

    if (result.code !== 0) {
      throw new LauncherError(
        `${FAILURE}: ${command.join(" ")} failed: ${lastLine(result.stderr) || `exit ${result.code}`}`,
        `run colima ssh --profile ${colima.profile} -- sudo ${command.join(" ")} to see why, then run pi again`,
      );
    }
  };

  const vmMarker = async () => {
    const result = await shell(["cat", MARKER]).catch(() => undefined);

    if (result?.code === 0) {
      return result.stdout.trim();
    }

    return result?.stderr.includes(MISSING_FILE) === true ? "" : undefined;
  };

  const restartEngine = () =>
    step(["systemctl", "restart", ...ENGINE_SERVICES], { timeoutMs: RESTART_TIMEOUT_MS });

  const awaitEngine = async () => {
    const detection = await colima.detectAgain(ENGINE_RESTART_DELAYS_MS);

    if (detection?.available !== true) {
      throw new LauncherError(
        `the sandbox VM engine did not come back after installing the tls.extraCa certificates: ${detection?.reason ?? "not detected"}`,
        `run colima ssh --profile ${colima.profile} -- sudo systemctl restart docker`,
      );
    }
  };

  const install = async (certificates: string[], hash: string) => {
    await step(["rm", "-rf", "--", MARKER, CERT_DIR]);

    await step(["mkdir", "-p", "--", CERT_DIR, MARKER_DIR]);

    await certificates.reduce(
      (previous, pem, index) => previous.then(() => step(["tee", "--", certPath(index)], { input: pem })),
      Promise.resolve(),
    );

    await step(["update-ca-certificates", "--fresh"]);

    await restartEngine();

    await step(["tee", "--", MARKER], { input: `${hash}\n` });

    await awaitEngine();
  };

  const remove = async () => {
    await step(["rm", "-rf", "--", CERT_DIR]);

    await step(["update-ca-certificates", "--fresh"]);

    await restartEngine();

    await step(["rm", "-f", "--", MARKER]);

    await awaitEngine();
  };

  const apply = async (certificates: string[], hash: string, options: VmShareOptions) => {
    if ((await vmMarker()) === hash) {
      return;
    }

    if ((await options.busy()) > 0) {
      options.report(DEFERRED);

      return;
    }

    options.report("installing the tls.extraCa certificates in the sandbox VM, one time");

    await (certificates.length === 0 ? remove() : install(certificates, hash));
  };

  const early: { marker?: Promise<string | undefined> } = {};

  const readEarly = () => {
    early.marker = vmMarker();
  };

  const takeMarker = () => {
    const marker = early.marker ?? vmMarker();

    early.marker = undefined;

    return marker;
  };

  const ensureTrust = async (pemPath: string, options: VmShareOptions) => {
    const certificates = certificatesIn(await readFile(pemPath, "utf8").catch(() => ""));
    const hash = certificates.length === 0 ? "" : sha256Hex(certificates.join(""));

    if ((await takeMarker()) === hash) {
      return;
    }

    await colima.withLock(() => apply(certificates, hash, options));
  };

  return { ensureTrust, readEarly };
};
