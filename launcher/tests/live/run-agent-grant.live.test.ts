import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type HttpsFixture, startHttpsFixture } from "./fixtures/https-fixture.ts";
import {
  type ChatRequest,
  conversationText,
  type LlmFixture,
  PROVIDER,
  type Reply,
  startLlmFixture,
  toolResults,
} from "./fixtures/llm-fixture.ts";
import { FIXTURE_HOSTS } from "./harness/names.ts";
import { createLiveSandbox, type LiveSandbox, liveEnabled, type PiResult } from "./harness/sandbox.ts";
import {
  authority,
  fixtureConfig,
  MODEL_ARGS,
  providerModels,
  providerSettings,
  randomSecret,
} from "./harness/scenario.ts";

const PAGE_MARKER = "granted page content from the fixture";

const MAIN_DONE = "main session saw the fetch agent result";

const WAIT_LIMIT_MS = 240_000;

interface Signal {
  promise: Promise<void>;
  resolve(): void;
}

const signal = (): Signal => {
  const holder: { resolve?: () => void } = {};
  const promise = new Promise<void>((resolve) => {
    holder.resolve = resolve;
  });

  return { promise, resolve: () => holder.resolve?.() };
};

const bounded = (promise: Promise<void>) =>
  Promise.race([promise, new Promise<void>((resolve) => setTimeout(resolve, WAIT_LIMIT_MS))]);

const toolNames = (request: ChatRequest) => (request.tools ?? []).map((tool) => tool.function.name);

describe.skipIf(!liveEnabled)("run_agent with the fetch agent and a session grant (live)", () => {
  const apiKey = randomSecret("fixture-provider-key");
  const denied = signal();
  const granted = signal();
  const fetched = signal();
  const firstResults: string[] = [];
  const state: { sandbox?: LiveSandbox; llm?: LlmFixture; page?: HttpsFixture; seenBeforeGrant?: number } =
    {};

  const pageUrl = () => state.page?.url(FIXTURE_HOSTS.page, "/doc") ?? "";

  const fetchCall = (): Reply => ({ tool: { name: "fetch", arguments: { url: pageUrl() } } });

  const subagent = async (request: ChatRequest): Promise<Reply> => {
    const last = toolResults(request).at(-1);

    if (last === undefined) {
      return fetchCall();
    }

    if (last.includes(PAGE_MARKER)) {
      fetched.resolve();

      return { text: `Status: done\nAnswer: ${PAGE_MARKER}\nVerification: fetched\nOpen: none` };
    }

    firstResults.push(last);

    state.seenBeforeGrant = state.page?.seen.length;

    denied.resolve();

    await bounded(granted.promise);

    return fetchCall();
  };

  const main = async (request: ChatRequest): Promise<Reply> => {
    if (toolResults(request).length === 0) {
      return {
        tool: {
          name: "run_agent",
          arguments: {
            agents: [
              {
                agent: "fetch",
                task: `Fetch ${pageUrl()} and quote what it says.`,
                model: `${PROVIDER.provider}/${PROVIDER.model}`,
              },
            ],
          },
        },
      };
    }

    await bounded(fetched.promise);

    return { text: conversationText(request).includes(PAGE_MARKER) ? MAIN_DONE : "main session is waiting" };
  };

  beforeAll(async () => {
    const sandbox = await createLiveSandbox("run-agent");

    state.sandbox = sandbox;

    state.page = await startHttpsFixture(sandbox.certificate, (_, response) => {
      response.writeHead(200, { "content-type": "text/plain" });

      response.end(PAGE_MARKER);
    });

    state.llm = await startLlmFixture(sandbox.certificate, apiKey, (request) =>
      toolNames(request).includes("run_agent") ? main(request) : subagent(request),
    );

    await sandbox.writeAgentFile("models.json", providerModels(state.llm.baseUrl(FIXTURE_HOSTS.llm), apiKey));

    await sandbox.writeAgentFile("settings.json", providerSettings());

    await sandbox.writeUserConfig(fixtureConfig(sandbox));
  }, 120_000);

  afterAll(async () => {
    granted.resolve();

    fetched.resolve();

    await state.llm?.close();

    await state.page?.close();

    await state.sandbox?.cleanup();
  }, 120_000);

  it("is denied first, fetches after pi sandbox egress allow --session, and names the denial on exit", async () => {
    const sandbox = state.sandbox as LiveSandbox;
    const page = state.page as HttpsFixture;
    const target = authority(FIXTURE_HOSTS.page, page.port);
    const session = sandbox.pi(["-p", "use the fetch agent", ...MODEL_ARGS]);
    const outcome = await Promise.race([
      denied.promise.then(() => "denied" as const),
      session.done.then(() => "exited" as const),
    ]);

    expect(outcome).toBe("denied");

    expect(state.seenBeforeGrant).toBe(0);

    console.log(`fetch result while denied:\n${firstResults.join("\n")}`);

    expect.soft(firstResults.join("\n")).toContain("not allowed");

    const grant = await sandbox.pi(["sandbox", "egress", "allow", target, "--session"]).done;

    expect(grant.code).toBe(0);

    granted.resolve();

    const result: PiResult = await session.done;

    expect(result.code).toBe(0);

    expect(page.seen.length).toBeGreaterThan(0);

    expect(result.stderr).toContain(FIXTURE_HOSTS.page);

    expect(result.stderr).toContain("pi sandbox egress allow");
  });
});
