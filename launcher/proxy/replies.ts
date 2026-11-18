import { type ServerResponse, STATUS_CODES } from "node:http";

export const PROXY_AGENT = "pi-sandbox";

export type RawHeader = readonly [string, string];

export const statusLine = (status: number, message?: string) =>
  `${status} ${message ?? STATUS_CODES[status] ?? ""}`;

export const rawHead = (status: string, headers: RawHeader[]) =>
  [`HTTP/1.1 ${status}`, ...headers.map(([name, value]) => `${name}: ${value}`), "", ""].join("\r\n");

export const rawResponse = (status: string, headers: RawHeader[], body: string) =>
  `${rawHead(status, [...headers, ["content-length", String(Buffer.byteLength(body))], ["connection", "close"]])}${body}`;

export const rawReply = (status: string, body: object, extra: RawHeader[] = []) =>
  rawResponse(
    status,
    [["proxy-agent", PROXY_AGENT], ...extra, ["content-type", "application/json"]],
    JSON.stringify(body),
  );

export const sendJson = (
  response: ServerResponse,
  status: number,
  body: object,
  extra: Record<string, string> = {},
) => {
  response.writeHead(status, { "content-type": "application/json", "proxy-agent": PROXY_AGENT, ...extra });

  response.end(JSON.stringify(body));
};

export const ESTABLISHED = rawHead("200 Connection Established", [["proxy-agent", PROXY_AGENT]]);
