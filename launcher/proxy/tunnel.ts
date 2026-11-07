import type { Socket } from "node:net";
import type { Denials, RecordAccess } from "./denials.ts";
import { type DialAccess, type Dialer, RestrictedAddressError } from "./dial.ts";
import { sniDenial } from "./policy.ts";
import { ESTABLISHED } from "./replies.ts";
import { clientHelloRecordLength, parseServerName } from "./sni.ts";

export interface Connection {
  host: string;
  port: number;
  repoHash: string;
  sni?: string;
  client: Socket;
}

interface TunnelOptions {
  dial: Dialer;
  accessOf: (host: string) => DialAccess;
  track: (socket: Socket) => void;
  record: RecordAccess;
  denials: Denials;
  helloTimeoutMs: number;
}

const HANDSHAKE_RECORD = 0x16;

const MAX_HELLO_BYTES = 16_389;

const isHelloComplete = (buffer: Buffer) => {
  if (buffer.length === 0) {
    return false;
  }

  const length = clientHelloRecordLength(buffer);

  return (
    buffer[0] !== HANDSHAKE_RECORD ||
    buffer.length >= MAX_HELLO_BYTES ||
    (length !== undefined && buffer.length >= length)
  );
};

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
  const { dial, accessOf, denials } = options;

  const splice = (connection: Connection, upstream: Socket, hello: Buffer) => {
    const { client } = connection;
    const start = { read: upstream.bytesRead, written: upstream.bytesWritten };

    client.once("close", () => {
      options.record({
        repo: connection.repoHash,
        host: connection.host,
        sni: connection.sni,
        decision: "allow",
        rule: "egress.allow",
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
    const { host, port, repoHash } = connection;
    const upstream = await dial(host, port, accessOf(host), repoHash).catch((error: Error) => error);

    if (!(upstream instanceof Error)) {
      return upstream;
    }

    const rule = upstream instanceof RestrictedAddressError ? upstream.rule : "upstream";

    denials.note(host, { rule, reason: upstream.message }, { port, repoHash });

    return undefined;
  };

  const restrictedResolution = async (host: string) => {
    const problem = await dial.checkAddresses?.(host, accessOf(host)).then(
      () => undefined,
      (error: unknown) => error,
    );

    return problem instanceof RestrictedAddressError ? problem : undefined;
  };

  return async (connection: Connection, head: Buffer) => {
    const { client, host, port, repoHash } = connection;
    const restricted = await restrictedResolution(host);

    if (restricted !== undefined) {
      denials.refuse(client, host, { rule: restricted.rule, reason: restricted.message }, { port, repoHash });

      return;
    }

    client.write(ESTABLISHED);

    const hello = await readClientHello(client, head, options.helloTimeoutMs);
    const sni = parseServerName(hello);
    const denial = sniDenial(host, sni);

    connection.sni = sni;

    if (denial !== undefined) {
      denials.note(host, denial, { port, repoHash, sni });

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
