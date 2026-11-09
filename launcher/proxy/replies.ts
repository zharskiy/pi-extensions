import type { ServerResponse } from "node:http";

export const PROXY_AGENT = "pi-sandbox";

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

export const ESTABLISHED = `HTTP/1.1 200 Connection Established\r\nProxy-Agent: ${PROXY_AGENT}\r\n\r\n`;
