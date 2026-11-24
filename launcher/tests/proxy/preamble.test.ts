import type { AddressInfo } from "node:net";
import { connect, type Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPreambleGate,
  PREAMBLE_LIMIT,
  PREAMBLE_TIMEOUT_MS,
  preambleText,
} from "../../proxy/preamble.ts";

const TOKEN = "b".repeat(64);

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.useRealTimers();

  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const startGate = async () => {
  const admitted: string[] = [];
  const gate = createPreambleGate(TOKEN, (socket) => {
    socket.once("data", (chunk: Buffer) => {
      admitted.push(chunk.toString("utf8"));

      socket.end("welcome");
    });
  });

  await new Promise<void>((resolve) => gate.listen(0, "127.0.0.1", resolve));

  cleanups.push(() => new Promise<void>((resolve) => gate.close(() => resolve())));

  return { port: (gate.address() as AddressInfo).port, admitted };
};

const outcome = (socket: Socket) =>
  new Promise<string>((resolve) => {
    const state = { reply: "" };

    socket.on("data", (chunk: Buffer) => {
      state.reply += chunk.toString("utf8");
    });

    socket.on("error", () => resolve(`closed:${state.reply}`));

    socket.on("close", () => resolve(`closed:${state.reply}`));
  });

const open = (port: number) => connect({ host: "127.0.0.1", port });

describe("createPreambleGate", () => {
  it("admits a connection whose first line is the preamble and hands on the bytes after it", async () => {
    const { port, admitted } = await startGate();
    const socket = open(port);
    const done = outcome(socket);

    socket.write(`${preambleText(TOKEN)}\nhello`);

    expect(await done).toBe("closed:welcome");
    expect(admitted).toEqual(["hello"]);
  });

  it("admits a preamble that arrives one byte at a time", async () => {
    const { port, admitted } = await startGate();
    const socket = open(port);
    const done = outcome(socket);
    const bytes = [...`${preambleText(TOKEN)}\n`];

    await bytes.reduce(
      (previous, byte) =>
        previous.then(
          () =>
            new Promise<void>((resolve) => {
              socket.write(byte, () => resolve());
            }),
        ),
      Promise.resolve(),
    );

    socket.write("after");

    expect(await done).toBe("closed:welcome");
    expect(admitted).toEqual(["after"]);
  });

  it("closes a connection with another token, without a reply", async () => {
    const { port, admitted } = await startGate();
    const socket = open(port);
    const done = outcome(socket);

    socket.write(`${preambleText("c".repeat(64))}\nhello`);

    expect(await done).toBe("closed:");
    expect(admitted).toEqual([]);
  });

  it("closes a connection that sends the limit without a newline", async () => {
    const { port, admitted } = await startGate();
    const socket = open(port);
    const done = outcome(socket);

    socket.write("x".repeat(PREAMBLE_LIMIT));

    expect(await done).toBe("closed:");
    expect(admitted).toEqual([]);
  });

  it("closes a connection that sends no line within the timeout", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const { port, admitted } = await startGate();
    const socket = open(port);
    const done = outcome(socket);

    await new Promise<void>((resolve) => socket.once("connect", () => resolve()));

    socket.write("PINATA ");

    await vi.waitFor(() => expect(vi.getTimerCount()).toBeGreaterThan(0));

    vi.advanceTimersByTime(PREAMBLE_TIMEOUT_MS);

    expect(await done).toBe("closed:");
    expect(admitted).toEqual([]);
  });
});
