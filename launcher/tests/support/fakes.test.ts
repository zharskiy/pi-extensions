import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createFakeBackend, stdinFrom, stdinOf } from "./fake-backend.ts";

const collect = () => {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];

  stream.on("data", (chunk: Buffer) => chunks.push(chunk));

  return { stream, text: () => Buffer.concat(chunks).toString("utf8") };
};

const SPEC = { containerId: "c1", env: {}, workdir: "/" };

describe("createFakeBackend exec", () => {
  it("records stdin given as a string and answers scripted commands by prefix", async () => {
    const fake = createFakeBackend({
      execScripts: [
        { command: ["cat"], stdout: "{}", code: 0 },
        { command: ["tar"], code: 2, stderr: "bad" },
      ],
    });
    const stdout = collect();
    const stderr = collect();

    const code = await fake.backend.exec(
      { ...SPEC, command: ["tar", "-x", "-C", "/home/pi/.pi/agent"] },
      { stdin: stdinFrom("archive bytes"), stdout: stdout.stream, stderr: stderr.stream, tty: false },
    );

    expect(code).toBe(2);
    expect(stderr.text()).toBe("bad");
    expect(
      stdinOf(fake.execs[0] ?? { spec: SPEC as never, tty: false, resizes: [], stdin: [] }).toString(),
    ).toBe("archive bytes");

    expect(
      await fake.backend.exec(
        { ...SPEC, command: ["cat", "/home/pi/.pi/agent/settings.json"] },
        { stdout: stdout.stream, stderr: stderr.stream, tty: false },
      ),
    ).toBe(0);

    await new Promise((resolve) => setImmediate(resolve));

    expect(stdout.text()).toBe("{}");
  });

  it("records a stdin stream also when a custom exec handles the call", async () => {
    const stdin = new PassThrough();
    const fake = createFakeBackend({
      exec: async (_spec, io) => {
        stdin.end("typed");

        await new Promise((resolve) => io.stdin?.once("end", resolve));

        return 5;
      },
    });
    const out = collect();

    expect(
      await fake.backend.exec(
        { ...SPEC, command: ["sh"] },
        { stdin, stdout: out.stream, stderr: out.stream, tty: false },
      ),
    ).toBe(5);
    expect(fake.execs[0]?.stdin.map(String).join("")).toBe("typed");
  });
});
