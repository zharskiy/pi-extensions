import { type ServerResponse, STATUS_CODES } from "node:http";

export const PROXY_AGENT = "pi-sandbox";

export type RawHeader = readonly [string, string];

const JSON_TYPE: RawHeader = ["content-type", "application/json"];

export const withAgent = (headers: readonly RawHeader[]): RawHeader[] => [
  ...headers,
  ["proxy-agent", PROXY_AGENT],
];

export const statusLine = (status: number, message?: string) =>
  `${status} ${message ?? STATUS_CODES[status] ?? ""}`;

export const rawHead = (status: string, headers: readonly RawHeader[]) =>
  [`HTTP/1.1 ${status}`, ...headers.map(([name, value]) => `${name}: ${value}`), "", ""].join("\r\n");

export const rawResponse = (status: string, headers: readonly RawHeader[], body: string) =>
  `${rawHead(status, [...headers, ["content-length", String(Buffer.byteLength(body))], ["connection", "close"]])}${body}`;

export const rawReply = (status: string, body: object, extra: readonly RawHeader[] = []) =>
  rawResponse(status, withAgent([JSON_TYPE, ...extra]), JSON.stringify(body));

export const sendReply = (
  response: ServerResponse,
  status: number,
  headers: readonly RawHeader[],
  body: string,
) => {
  response.writeHead(
    status,
    [...withAgent(headers), ["content-length", String(Buffer.byteLength(body))]].flat(),
  );

  response.end(body);
};

export const sendJson = (
  response: ServerResponse,
  status: number,
  body: object,
  extra: readonly RawHeader[] = [],
) => sendReply(response, status, [JSON_TYPE, ...extra], JSON.stringify(body));

export const ESTABLISHED = rawHead("200 Connection Established", withAgent([]));
