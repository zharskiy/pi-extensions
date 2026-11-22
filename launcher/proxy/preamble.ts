import { createHash, timingSafeEqual } from "node:crypto";
import { connect, createServer, type Socket } from "node:net";

const PREAMBLE_PREFIX = "PI-SANDBOX ";

const NEWLINE = 0x0a;

export const PREAMBLE_LIMIT = 128;

export const PREAMBLE_TIMEOUT_MS = 5000;

export const preambleText = (token: string) => `${PREAMBLE_PREFIX}${token}`;

const preambleLine = (token: string) => `${preambleText(token)}\n`;

const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest();

export const connectWithPreamble = (host: string, port: number, token: string) => {
  const socket = connect({ host, port });

  socket.write(preambleLine(token));

  return socket;
};

const readPreamble = (socket: Socket, expected: Buffer, admit: (socket: Socket) => void) => {
  const state = { pending: Buffer.alloc(0) };
  const timer = setTimeout(() => socket.destroy(), PREAMBLE_TIMEOUT_MS);

  const onData = (chunk: Buffer) => {
    state.pending = Buffer.concat([state.pending, chunk]);

    const end = state.pending.indexOf(NEWLINE);

    if (end === -1 && state.pending.length >= PREAMBLE_LIMIT) {
      socket.destroy();

      return;
    }

    if (end === -1) {
      return;
    }

    socket.off("data", onData);

    socket.pause();

    clearTimeout(timer);

    const line = state.pending.subarray(0, end + 1);

    if (line.length > PREAMBLE_LIMIT || !timingSafeEqual(digest(line), expected)) {
      socket.destroy();

      return;
    }

    const rest = state.pending.subarray(end + 1);

    if (rest.length > 0) {
      socket.unshift(rest);
    }

    admit(socket);

    socket.resume();
  };

  socket.once("close", () => clearTimeout(timer));

  socket.on("error", () => socket.destroy());

  socket.on("data", onData);
};

export const createPreambleGate = (token: string, admit: (socket: Socket) => void) => {
  const expected = digest(preambleLine(token));

  return createServer({ allowHalfOpen: true }, (socket) => readPreamble(socket, expected, admit));
};
