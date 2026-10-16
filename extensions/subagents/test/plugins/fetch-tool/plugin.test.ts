import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchToolPlugin } from "../../../src/plugins/fetch-tool/index.ts";
import { createHarness } from "../../helpers/harness.ts";

const html = (body: string) =>
  new Response(`<html><head><title>Docs</title></head><body>${body}</body></html>`, {
    status: 200,
    statusText: "OK",
    headers: { "content-type": "text/html; charset=utf-8" },
  });

const stubFetch = (respond: () => Response | Promise<Response>) => {
  const stub = vi.fn(async () => respond());

  vi.stubGlobal("fetch", stub);

  return stub;
};

const setup = (overrides = {}) => {
  const harness = createHarness([fetchToolPlugin], overrides);

  return { ...harness, tool: harness.services.require("fetchTool").tool() as never as FetchTool };
};

type FetchTool = {
  name: string;
  parameters: Record<string, unknown>;
  executionMode?: string;
  execute(
    params: { url: string },
    ctx: { update(text: string): void },
  ): Promise<{ text: string; isError?: boolean }>;
};

const run = (tool: FetchTool, url: string) => tool.execute({ url }, { update: () => {} });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetch-tool plugin", () => {
  it("provides the fetch tool with a url parameter", () => {
    const { tool, errors } = setup();

    expect(errors).toEqual([]);
    expect(tool.name).toBe("fetch");
    expect(tool.executionMode).toBe("parallel");

    expect(tool.parameters).toMatchObject({
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
    });
  });

  it("returns url, status, title and fetched lines, then the text", async () => {
    stubFetch(() => html("<p>Hello world</p>"));

    const { tool } = setup();
    const result = await run(tool, "https://example.com/a");
    const lines = result.text.split("\n");

    expect(result.isError).toBeUndefined();
    expect(lines[0]).toBe("URL: https://example.com/a");
    expect(lines[1]).toBe("Status: 200 OK");
    expect(lines[2]).toBe("Title: Docs");
    expect(lines[3]).toMatch(/^Fetched: \d{4}-\d{2}-\d{2}T/);
    expect(result.text).toContain("\n\nHello world");
    expect(result.text).not.toContain("Truncated:");
  });

  it("adds a Truncated line only when the page was cut", async () => {
    stubFetch(() => html(`<p>${"word ".repeat(1000)}</p>`));

    const { tool } = setup({ fetchMaxChars: 1000 });
    const result = await run(tool, "https://example.com/long");

    expect(result.text).toMatch(/^Truncated: 1000 of \d+ chars$/m);
  });

  it("adds a Truncated line when the body was cut at the byte cap", async () => {
    stubFetch(() => html(`<p>${"word ".repeat(1000)}</p>`));

    const { tool } = setup({ fetchMaxBytes: 500 });
    const result = await run(tool, "https://example.com/big");

    expect(result.text).toMatch(/^Truncated: body cut at 500 bytes$/m);
  });

  it("returns http error statuses as normal results", async () => {
    stubFetch(
      () =>
        new Response("<p>gone</p>", {
          status: 404,
          statusText: "Not Found",
          headers: { "content-type": "text/html" },
        }),
    );

    const { tool } = setup();
    const result = await run(tool, "https://example.com/missing");

    expect(result.isError).toBeUndefined();
    expect(result.text).toContain("Status: 404 Not Found");
    expect(result.text).toContain("gone");
  });

  it("returns failures as error text with the url and reason", async () => {
    stubFetch(() => {
      throw new TypeError("fetch failed");
    });

    const { tool } = setup();
    const failed = await run(tool, "https://example.com/down");
    const scheme = await run(tool, "ftp://example.com/file");
    const invalid = await run(tool, "not a url");

    expect(failed).toEqual({
      text: expect.stringMatching(/^Fetch failed: https:\/\/example\.com\/down: .+/),
      isError: true,
    });
    expect(scheme.isError).toBe(true);
    expect(scheme.text).toMatch(/^Fetch failed: ftp:\/\/example\.com\/file: /);
    expect(invalid.isError).toBe(true);
    expect(invalid.text).toMatch(/^Fetch failed: not a url: /);
  });

  it("can be disabled through disabledPlugins", () => {
    const { services } = createHarness([fetchToolPlugin], { disabledPlugins: ["fetch-tool"] });

    expect(() => services.require("fetchTool")).toThrow("not provided");
  });
});
