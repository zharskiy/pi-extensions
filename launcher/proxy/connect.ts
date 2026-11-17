import type { Socket } from "node:net";

export const CONNECT_TIMEOUT_MS = 10_000;

export const connected = (socket: Socket, timeoutMs: number, timeoutMessage: string) =>
  new Promise<Socket>((resolve, reject) => {
    const fail = (error: Error) => {
      clearTimeout(timer);

      reject(error);
    };

    const timer = setTimeout(() => {
      socket.off("error", fail);

      socket.destroy();

      reject(new Error(timeoutMessage));
    }, timeoutMs);

    socket.once("connect", () => {
      clearTimeout(timer);

      socket.off("error", fail);

      resolve(socket);
    });

    socket.once("error", fail);
  });
