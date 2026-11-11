import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { LauncherError } from "../../shared/index.ts";
import { createFakeBackend } from "./fake-backend.ts";
import { createFakeRunner } from "./fake-runner.ts";

describe("createFakeRunner", () => {
  it("rejects like a missing command when the responder has no answer", async () => {
    const { runner } = createFakeRunner(() => undefined);

    await expect(runner.run("colima", ["status"])).rejects.toBeInstanceOf(LauncherError);
  });

  it("records env, cwd and input of each call", async () => {
    const { runner, calls } = createFakeRunner(() => ({}));

    await runner.run("pi", ["mcp", "list"], {
      cwd: "/tmp/empty",
      env: { PI_CODING_AGENT_DIR: "/state" },
      input: "y",
    });

    expect(calls[0]?.options).toEqual({
      cwd: "/tmp/empty",
      env: { PI_CODING_AGENT_DIR: "/state" },
      input: "y",
    });
  });
});

describe("createFakeBackend exec", () => {
  it("records a stdin stream also when a custom exec handles the call", async () => {
    const stdin = new PassThrough();
    const out = new PassThrough();
    const fake = createFakeBackend({
      exec: async (_spec, io) => {
        stdin.end("typed");

        await new Promise((resolve) => io.stdin?.once("end", resolve));

        return 5;
      },
    });

    expect(
      await fake.backend.exec(
        { containerId: "c1", env: {}, workdir: "/", command: ["sh"] },
        { stdin, stdout: out, stderr: out, tty: false },
      ),
    ).toBe(5);
    expect(fake.execs[0]?.stdin.map(String).join("")).toBe("typed");
  });

  it("never runs a pi session exec in a real shell, even when its command names a bind path", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-sandbox-fake-guest-"));
    const marker = join(root, "ran");
    const out = new PassThrough();
    const fake = createFakeBackend({ guestAgentDir: join(root, "agent") });
    const { id } = await fake.backend.createContainer({
      name: "pi-sandbox-test-0000000000000001",
      image: "sha256:image",
      labels: {},
      mounts: [{ kind: "bind", source: root, target: root, readOnly: false }],
      network: { kind: "none" },
      env: {},
      workdir: root,
      readOnlyRoot: true,
      tmpfs: [],
      init: true,
      resources: {},
    });

    await fake.backend.startContainer(id);

    const code = await fake.backend.exec(
      {
        containerId: id,
        env: { PI_SANDBOX_LAUNCH_ID: "0000000000000001" },
        workdir: root,
        command: ["sh", "-c", `touch ${marker}; cd "$1"; shift; exec "$@"`, "sh", root, "pi"],
      },
      { stdout: out, stderr: out, tty: false },
    );
    const ran = existsSync(marker);

    rmSync(root, { recursive: true, force: true });

    expect(code).toBe(0);
    expect(ran).toBe(false);
  });
});
