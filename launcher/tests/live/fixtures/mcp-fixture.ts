import type { ServerResponse } from "node:http";
import { type HttpsFixture, type SeenRequest, sendJson, startHttpsFixture } from "./https-fixture.ts";
import type { TestCertificate } from "./test-ca.ts";

export interface McpFixtureOptions {
  tool: string;
  authorize(token: string): boolean;
  authorizationServer?: () => string;
}

export interface McpFixture extends HttpsFixture {
  endpoint(host: string): string;
  tokens(): string[];
}

interface RpcRequest {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: { protocolVersion?: string; name?: string };
}

const MCP_PATH = "/mcp";

const PROTECTED_RESOURCE = "/.well-known/oauth-protected-resource";

const bearerOf = (request: SeenRequest) => {
  const header = String(request.headers.authorization ?? "");

  return header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
};

const resultFor = (rpc: RpcRequest, tool: string) => {
  if (rpc.method === "initialize") {
    return {
      protocolVersion: rpc.params?.protocolVersion ?? "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "pi-sandbox-fixture", version: "1.0.0" },
    };
  }

  if (rpc.method === "tools/list") {
    return {
      tools: [{ name: tool, description: "Fixture tool", inputSchema: { type: "object", properties: {} } }],
    };
  }

  if (rpc.method === "tools/call") {
    return { content: [{ type: "text", text: `${tool} called` }] };
  }

  return {};
};

const answerRpc = (request: SeenRequest, response: ServerResponse, tool: string) => {
  const rpc = JSON.parse(request.body) as RpcRequest;

  if (rpc.id === undefined) {
    response.writeHead(202);

    response.end();

    return;
  }

  sendJson(response, 200, { jsonrpc: "2.0", id: rpc.id, result: resultFor(rpc, tool) });
};

export const startMcpFixture = async (
  certificate: TestCertificate,
  options: McpFixtureOptions,
): Promise<McpFixture> => {
  const holder: { fixture?: HttpsFixture } = {};
  const metadataUrl = (request: SeenRequest) => holder.fixture?.url(request.host, PROTECTED_RESOURCE) ?? "";

  const fixture = await startHttpsFixture(certificate, (request, response) => {
    if (request.path.startsWith(PROTECTED_RESOURCE) && options.authorizationServer !== undefined) {
      sendJson(response, 200, {
        resource: holder.fixture?.url(request.host, MCP_PATH),
        authorization_servers: [options.authorizationServer()],
        bearer_methods_supported: ["header"],
      });

      return;
    }

    if (!request.path.startsWith(MCP_PATH)) {
      sendJson(response, 404, { error: "not found" });

      return;
    }

    if (!options.authorize(bearerOf(request))) {
      const challenge =
        options.authorizationServer === undefined
          ? 'Bearer realm="fixture"'
          : `Bearer resource_metadata="${metadataUrl(request)}"`;

      sendJson(response, 401, { error: "unauthorized" }, { "www-authenticate": challenge });

      return;
    }

    if (request.method !== "POST") {
      response.writeHead(request.method === "DELETE" ? 200 : 405);

      response.end();

      return;
    }

    answerRpc(request, response, options.tool);
  });

  holder.fixture = fixture;

  return {
    ...fixture,
    endpoint: (host) => fixture.url(host, MCP_PATH),
    tokens: () => fixture.seen.filter((request) => request.path.startsWith(MCP_PATH)).map(bearerOf),
  };
};
