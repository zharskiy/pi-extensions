import type { ServerResponse } from "node:http";
import type { Readable } from "node:stream";

export const PROXY_AGENT = "pi-sandbox";

interface Limited {
  body?: Buffer;
  overflow: boolean;
}

export const rawReply = (status: string, body: object, extra: string[] = []) => {
  const text = JSON.stringify(body);

  return [
    `HTTP/1.1 ${status}`,
    `Proxy-Agent: ${PROXY_AGENT}`,
    ...extra,
    "Content-Type: application/json",
    `Content-Length: ${Buffer.byteLength(text)}`,
    "Connection: close",
    "",
    text,
  ].join("\r\n");
};

export const sendJson = (
  response: ServerResponse,
  status: number,
  body: object,
  extra: Record<string, string> = {},
) => {
  response.writeHead(status, { "content-type": "application/json", "proxy-agent": PROXY_AGENT, ...extra });

  response.end(JSON.stringify(body));
};

export const sendJsonAndClose = (response: ServerResponse, status: number, body: object) => {
  response.once("finish", () => response.socket?.destroySoon());

  sendJson(response, status, body, { connection: "close" });
};

export const readLimited = (stream: Readable, limit: number) =>
  new Promise<Limited>((resolve) => {
    const chunks: Buffer[] = [];
    const state = { size: 0 };

    const onData = (chunk: Buffer) => {
      state.size += chunk.length;

      if (state.size > limit) {
        stream.off("data", onData);

        stream.pause();

        resolve({ overflow: true });

        return;
      }

      chunks.push(chunk);
    };

    stream.on("data", onData);

    stream.once("end", () => resolve({ body: Buffer.concat(chunks), overflow: false }));

    stream.once("error", () => resolve({ overflow: false }));
  });

export const ESTABLISHED = `HTTP/1.1 200 Connection Established\r\nProxy-Agent: ${PROXY_AGENT}\r\n\r\n`;
