import type { Socket } from "node:net";
import type { Denials, RecordAccess } from "./denials.ts";
import { type Dial, type DialAccess, RestrictedAddressError } from "./dial.ts";
import { sniDenial } from "./policy.ts";
import { ESTABLISHED } from "./replies.ts";
import { isHelloComplete, parseServerName } from "./sni.ts";

export interface Connection {
  host: string;
  port: number;
  access: DialAccess;
  sni?: string;
  rule?: string;
  client: Socket;
}

interface TunnelOptions {
  dial: Dial;
  track: (socket: Socket) => void;
  record: RecordAccess;
  denials: Denials;
  helloTimeoutMs: number;
}

const readClientHello = (socket: Socket, head: Buffer, timeoutMs: number) =>
  new Promise<Buffer>((resolve) => {
    const state = { buffer: head };

    const finish = () => {
      clearTimeout(timer);

      socket.off("data", collect);

      socket.off("end", finish);

      socket.off("close", finish);

      socket.pause();

      resolve(state.buffer);
    };

    const collect = (chunk: Buffer) => {
      state.buffer = Buffer.concat([state.buffer, chunk]);

      if (isHelloComplete(state.buffer)) {
        finish();
      }
    };

    const timer = setTimeout(finish, timeoutMs);

    socket.on("data", collect);

    socket.once("end", finish);

    socket.once("close", finish);

    if (isHelloComplete(state.buffer)) {
      finish();
    }

    socket.resume();
  });

export const createTunnel = (options: TunnelOptions) => {
  const { dial, denials } = options;

  const splice = (connection: Connection, upstream: Socket, hello: Buffer) => {
    const { client } = connection;
    const start = { read: upstream.bytesRead, written: upstream.bytesWritten };

    client.once("close", () => {
      options.record({
        host: connection.host,
        sni: connection.sni,
        decision: "allow",
        rule: connection.rule ?? "egress.allow",
        bytesIn: upstream.bytesRead - start.read,
        bytesOut: upstream.bytesWritten - start.written,
      });

      upstream.destroy();
    });

    upstream.on("error", () => client.destroy());

    upstream.on("close", () => client.destroy());

    upstream.write(hello);

    client.pipe(upstream).pipe(client);

    client.resume();
  };

  const dialUpstream = async (connection: Connection) => {
    const { host, port } = connection;
    const upstream = await dial(host, port, connection.access).catch((error: Error) => error);

    if (!(upstream instanceof Error)) {
      return upstream;
    }

    const rule = upstream instanceof RestrictedAddressError ? upstream.rule : "upstream";

    denials.note(host, { rule, reason: upstream.message }, { port });

    return undefined;
  };

  return async (connection: Connection, head: Buffer) => {
    const { client, host, port } = connection;

    if (client.destroyed) {
      return;
    }

    client.write(ESTABLISHED);

    const hello = await readClientHello(client, head, options.helloTimeoutMs);

    if (hello.length === 0 && (client.destroyed || client.readableEnded)) {
      client.destroy();

      return;
    }

    const sni = parseServerName(hello);
    const denial = sniDenial(host, sni);

    connection.sni = sni;

    if (denial !== undefined) {
      denials.note(host, denial, { port, sni });

      client.destroy();

      return;
    }

    if (client.destroyed) {
      return;
    }

    const upstream = await dialUpstream(connection);

    if (upstream === undefined) {
      client.destroy();

      return;
    }

    options.track(upstream);

    if (client.destroyed) {
      upstream.destroy();

      return;
    }

    splice(connection, upstream, hello);
  };
};
