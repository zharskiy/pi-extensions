import { readFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { type HttpsFixture, type SeenRequest, sendJson, startHttpsFixture } from "./https-fixture.ts";
import type { TestCertificate } from "./test-ca.ts";

export interface ProviderFixture {
  api: string;
  provider: string;
  model: string;
  path: string;
}

interface ChatMessage {
  role: string;
  content?: unknown;
  tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: Array<{ function: { name: string } }>;
}

export type Reply = { text: string } | { tool: { name: string; arguments: Record<string, unknown> } };

export type Script = (request: ChatRequest) => Reply | Promise<Reply>;

export interface LlmFixture extends HttpsFixture {
  baseUrl(host: string): string;
  authorizations(): string[];
}

export const PROVIDER: ProviderFixture = JSON.parse(
  readFileSync(new URL("./provider.json", import.meta.url), "utf8"),
) as ProviderFixture;

const contentText = (content: unknown): string => {
  if (typeof content === "string") {
    return content;
  }

  return Array.isArray(content)
    ? content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("")
    : "";
};

export const conversationText = (request: ChatRequest) =>
  request.messages.map((message) => contentText(message.content)).join("\n");

export const toolResults = (request: ChatRequest) =>
  request.messages
    .filter((message) => message.role === "tool")
    .map((message) => contentText(message.content));

const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
  `data: ${JSON.stringify({
    id: "fixture",
    object: "chat.completion.chunk",
    created: 0,
    model: PROVIDER.model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;

const usage = () =>
  `data: ${JSON.stringify({
    id: "fixture",
    object: "chat.completion.chunk",
    created: 0,
    model: PROVIDER.model,
    choices: [],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  })}\n\n`;

const streamOf = (reply: Reply) => {
  if ("text" in reply) {
    return [chunk({ role: "assistant", content: reply.text }), chunk({}, "stop")];
  }

  const call = {
    index: 0,
    id: `call_${Date.now().toString(36)}`,
    type: "function",
    function: { name: reply.tool.name, arguments: JSON.stringify(reply.tool.arguments) },
  };

  return [chunk({ role: "assistant", content: null, tool_calls: [call] }), chunk({}, "tool_calls")];
};

const respond = async (script: Script, request: SeenRequest, response: ServerResponse) => {
  const reply = await script(JSON.parse(request.body) as ChatRequest);

  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });

  response.end([...streamOf(reply), usage(), "data: [DONE]\n\n"].join(""));
};

export const startLlmFixture = async (
  certificate: TestCertificate,
  key: string,
  script: Script,
): Promise<LlmFixture> => {
  const fixture = await startHttpsFixture(certificate, async (request, response) => {
    if (request.headers.authorization !== `Bearer ${key}`) {
      sendJson(response, 401, { error: { message: "invalid api key" } });

      return;
    }

    if (request.method === "POST" && request.path.startsWith(`${PROVIDER.path}/chat/completions`)) {
      await respond(script, request, response);

      return;
    }

    sendJson(response, 404, { error: { message: `no route ${request.path}` } });
  });

  return {
    ...fixture,
    baseUrl: (host) => fixture.url(host, PROVIDER.path),
    authorizations: () => fixture.seen.map((request) => String(request.headers.authorization ?? "")),
  };
};
