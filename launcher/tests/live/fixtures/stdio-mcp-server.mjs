import { createInterface } from "node:readline";

const catalog = async () => {
  const response = await fetch(process.env.CATALOG_URL ?? "");
  const body = await response.json();

  return body.tool;
};

const results = {
  initialize: async (params) => ({
    protocolVersion: params?.protocolVersion ?? "2025-06-18",
    capabilities: { tools: {} },
    serverInfo: { name: "pi-sandbox-stdio-fixture", version: "1.0.0" },
  }),
  "tools/list": async () => ({
    tools: [
      {
        name: await catalog(),
        description: "Tool named by the catalog",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  }),
  "tools/call": async () => ({ content: [{ type: "text", text: "stdio fixture called" }] }),
};

const reply = (message) => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

const answer = async (line) => {
  const request = JSON.parse(line);

  if (request.id === undefined) {
    return;
  }

  const handler = results[request.method];

  if (handler === undefined) {
    reply({ jsonrpc: "2.0", id: request.id, result: {} });

    return;
  }

  try {
    reply({ jsonrpc: "2.0", id: request.id, result: await handler(request.params) });
  } catch (error) {
    reply({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: String(error) } });
  }
};

createInterface({ input: process.stdin }).on("line", (line) => {
  if (line.trim() !== "") {
    void answer(line);
  }
});
