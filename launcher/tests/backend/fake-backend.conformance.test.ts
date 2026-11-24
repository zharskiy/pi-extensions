import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ContainerSpec } from "../../backend/index.ts";
import { execCapture } from "../../backend/index.ts";
import { GUEST_PATHS, LauncherError } from "../../shared/index.ts";
import { createFakeBackend, FAKE_INSTALL } from "../support/fake-backend.ts";
import { tempDir } from "../support/temp-dir.ts";
import { runBackendConformance } from "./conformance.ts";

const PULLABLE = "example.test/pinata:1";

const REPO_A = "a".repeat(64);

runBackendConformance("fake backend", { describe, it, expect, beforeAll, afterAll }, async () => {
  const guestAgentDir = await mkdtemp(join(tmpdir(), "pinata-fake-guest-"));
  const fake = createFakeBackend({ registry: { [PULLABLE]: `sha256:${"c".repeat(64)}` }, guestAgentDir });

  return {
    backend: fake.backend,
    install: FAKE_INSTALL,
    pullableImage: PULLABLE,
    runnableImage: PULLABLE,
    networks: {
      has: async (name) => fake.hasNetwork(name),
      remove: async (name) => fake.dropNetwork(name),
      plantForeign: async (name) => fake.plantForeignNetwork(name),
    },
    dispose: () => rm(guestAgentDir, { recursive: true, force: true }),
  };
});

const specFor = (name: string, repoHash = REPO_A): ContainerSpec => ({
  name,
  image: PULLABLE,
  labels: { "pinata.repo-hash": repoHash },
  mounts: [],
  network: { kind: "none" },
  env: {},
  workdir: "/",
  readOnlyRoot: true,
  tmpfs: [],
  init: true,
  resources: { pids: 4096 },
  capabilities: ["CHOWN"],
  autoRemove: true,
});

const execSpec = (containerId: string, script: string) => ({
  containerId,
  command: ["sh", "-c", script],
  env: {},
  workdir: "/",
});

describe("fake backend contract", () => {
  it("refuses exec on a container that is not running", async () => {
    const fake = createFakeBackend();
    const { id } = await fake.backend.createContainer(specFor("stopped"));

    await expect(execCapture(fake.backend, execSpec(id, "true"))).rejects.toThrow(
      `container ${id} is not running`,
    );

    await fake.backend.startContainer(id);

    await fake.backend.stopContainer(id);

    await expect(execCapture(fake.backend, execSpec(id, "true"))).rejects.toBeInstanceOf(LauncherError);
  });

  it("names the taken container name and tolerates removing an unknown id", async () => {
    const fake = createFakeBackend();

    await fake.backend.createContainer(specFor("taken"));

    await expect(fake.backend.createContainer(specFor("taken"))).rejects.toMatchObject({
      message: "unexpected name clash: container name taken is already in use",
      hint: undefined,
    });
    await expect(fake.backend.removeContainer("missing")).resolves.toBeUndefined();
  });

  it("runs sh against the guest agent dir and reads its files back", async () => {
    const fake = createFakeBackend({ guestAgentDir: await tempDir("fake-guest") });
    const { id } = await fake.backend.createContainer(specFor("guest"));

    await fake.backend.startContainer(id);

    const result = await execCapture(
      fake.backend,
      execSpec(id, `cat > ${GUEST_PATHS.agentDir}/note.txt; echo done; echo warn >&2`),
      "from stdin",
    );

    expect(result).toEqual({ code: 0, stdout: "done\n", stderr: "warn\n" });
    expect(await fake.guestFile("note.txt")).toBe("from stdin");
    expect(await fake.guestFile("absent.txt")).toBeUndefined();
  });
});
