import { createServer, type Server } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDialer, RestrictedAddressError } from "../../proxy/dial.ts";
import { TEST_RESOLVE_ENV, testResolveOverrides } from "../../proxy/test-resolve.ts";

const DEV_MODULE = "file:///checkout/launcher/proxy/test-resolve.ts";

const COMPILED_MODULE = "file:///usr/lib/node_modules/pi-extensions-mz/launcher/dist/proxy/test-resolve.js";

const VALUE = "llm.fixtures.test=127.0.0.1, MCP.fixtures.test=::1,broken,bad.test=not-an-ip";

const state: { server?: Server; port: number } = { port: 0 };

beforeAll(async () => {
  const server = createServer((socket) => {
    socket.on("error", () => undefined);

    socket.end("hello");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const address = server.address();

  state.server = server;

  state.port = typeof address === "object" && address !== null ? address.port : 0;
});

afterAll(() => {
  state.server?.close();
});

describe("test resolver seam", () => {
  it("maps names to addresses in a checkout", () => {
    const overrides = testResolveOverrides({ [TEST_RESOLVE_ENV]: VALUE }, DEV_MODULE);

    expect(Object.fromEntries(overrides)).toEqual({
      "llm.fixtures.test": "127.0.0.1",
      "mcp.fixtures.test": "::1",
    });
  });

  it("is ignored by the compiled launcher", () => {
    expect(testResolveOverrides({ [TEST_RESOLVE_ENV]: VALUE }, COMPILED_MODULE).size).toBe(0);
  });

  it("dials an overridden private host", async () => {
    const dial = createDialer({ overrides: testResolveOverrides({ [TEST_RESOLVE_ENV]: VALUE }, DEV_MODULE) });
    const socket = await dial("llm.fixtures.test", state.port, "private");

    expect(socket.remotePort).toBe(state.port);

    socket.destroy();
  });

  it("keeps the private-range deny for public hosts", async () => {
    const dial = createDialer({ overrides: testResolveOverrides({ [TEST_RESOLVE_ENV]: VALUE }, DEV_MODULE) });

    await expect(dial("llm.fixtures.test", state.port, "public")).rejects.toBeInstanceOf(
      RestrictedAddressError,
    );
  });
});
