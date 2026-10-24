import { createInterface } from "node:readline";

type Request = { id?: number | string; method?: string; params?: { protocolVersion?: string } };

const code = process.argv[2] ?? "";

const TOOL = {
  name: "code",
  description: "Returns the fixture server's code word.",
  inputSchema: { type: "object", properties: {} },
};

const handlers: Record<string, (request: Request) => unknown> = {
  initialize: (request) => ({
    protocolVersion: request.params?.protocolVersion ?? "2025-06-18",
    capabilities: { tools: {} },
    serverInfo: { name: "fixture", version: "1.0.0" },
  }),
  ping: () => ({}),
  "tools/list": () => ({ tools: [TOOL] }),
  "tools/call": () => ({ content: [{ type: "text", text: code }] }),
};

const reply = (message: Record<string, unknown>) => {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
};

const answer = (line: string) => {
  const request = JSON.parse(line) as Request;

  if (request.id === undefined) {
    return;
  }

  const handle = handlers[request.method ?? ""];

  if (!handle) {
    reply({ id: request.id, error: { code: -32601, message: `unknown method ${request.method}` } });
    return;
  }

  reply({ id: request.id, result: handle(request) });
};

createInterface({ input: process.stdin }).on("line", answer);
