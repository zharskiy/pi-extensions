import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchPage } from "../../../core/fetch-tool/fetch.ts";

const LIMITS = { timeoutSeconds: 5, maxBytes: 100000, maxChars: 10000 };

const reply = (
  body: ConstructorParameters<typeof Response>[0],
  init: ResponseInit & { url?: string } = {},
) => {
  const response = new Response(body, init);

  if (init.url) {
    Object.defineProperty(response, "url", { value: init.url });
  }

  return response;
};

const stubFetch = (response: () => Response | Promise<Response>) => {
  const stub = vi.fn(async (..._args: unknown[]) => response());

  vi.stubGlobal("fetch", stub);

  return stub;
};

const hang = () =>
  vi.fn(
    (_url: unknown, init: { signal: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason));
      }),
  );

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchPage", () => {
  it("returns title, text and status of an html page", async () => {
    const stub = stubFetch(() =>
      reply("<title>T</title><p>Hi</p>", {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "text/html" },
      }),
    );
    const page = await fetchPage("https://example.com/a", LIMITS);

    expect(page).toMatchObject({
      url: "https://example.com/a",
      status: 200,
      reason: "OK",
      title: "T",
      text: "Hi",
      bytesCut: false,
    });
    expect(page.chars).toEqual({ shown: 2, total: 2 });
    expect(stub.mock.calls[0][1]).toMatchObject({ redirect: "follow" });
  });

  it("reports the final URL after redirects", async () => {
    stubFetch(() =>
      reply("<p>x</p>", { headers: { "content-type": "text/html" }, url: "https://example.com/final" }),
    );

    expect((await fetchPage("https://example.com/start", LIMITS)).url).toBe("https://example.com/final");
  });

  it("returns a 404 as a status with the page text", async () => {
    stubFetch(() =>
      reply("<p>Missing</p>", {
        status: 404,
        statusText: "Not Found",
        headers: { "content-type": "text/html" },
      }),
    );
    const page = await fetchPage("https://example.com/none", LIMITS);

    expect(page.status).toBe(404);
    expect(page.reason).toBe("Not Found");
    expect(page.text).toBe("Missing");
  });

  it("refuses non-http URLs without fetching", async () => {
    const stub = stubFetch(() => reply("x"));

    await expect(fetchPage("file:///etc/passwd", LIMITS)).rejects.toThrow("only http and https");
    await expect(fetchPage("ftp://example.com/x", LIMITS)).rejects.toThrow("only http and https");
    await expect(fetchPage("not a url", LIMITS)).rejects.toThrow("not a valid URL");
    expect(stub).not.toHaveBeenCalled();
  });

  it("stops reading at maxBytes and cancels the stream", async () => {
    const pulled = vi.fn();
    const cancelled = vi.fn();
    const chunk = new TextEncoder().encode("a".repeat(400));
    let sent = 0;

    const stream = new ReadableStream<Uint8Array>(
      {
        pull: (controller) => {
          pulled();
          sent += 1;
          controller.enqueue(chunk);
        },
        cancel: cancelled,
      },
      { highWaterMark: 0 },
    );

    stubFetch(() => reply(stream, { headers: { "content-type": "text/plain" } }));
    const page = await fetchPage("https://example.com/big", { ...LIMITS, maxBytes: 1000 });

    expect(page.bytesCut).toBe(true);
    expect(page.chars.total).toBe(1000);
    expect(sent).toBe(3);
    expect(pulled).toHaveBeenCalledTimes(3);
    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it("cancels the body of an unsupported type without reading it", async () => {
    const pulled = vi.fn();
    const cancelled = vi.fn();

    const stream = new ReadableStream<Uint8Array>({ pull: pulled, cancel: cancelled }, { highWaterMark: 0 });

    stubFetch(() => reply(stream, { headers: { "content-type": "image/png" } }));

    await expect(fetchPage("https://example.com/a.png", LIMITS)).rejects.toThrow(
      "unsupported content type image/png",
    );
    expect(pulled).not.toHaveBeenCalled();
    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it("cuts text at maxChars and reports n of m", async () => {
    stubFetch(() => reply("b".repeat(300), { headers: { "content-type": "text/plain" } }));
    const page = await fetchPage("https://example.com/long", { ...LIMITS, maxChars: 100 });

    expect(page.text).toHaveLength(100);
    expect(page.chars).toEqual({ shown: 100, total: 300 });
  });

  it("decodes by the declared charset", async () => {
    stubFetch(() =>
      reply(new Uint8Array([0x63, 0x61, 0x66, 0xe9]), {
        headers: { "content-type": "text/plain; charset=iso-8859-1" },
      }),
    );

    expect((await fetchPage("https://example.com/l1", LIMITS)).text).toBe("café");
  });

  it("reports unsupported content types", async () => {
    stubFetch(() => reply("x", { headers: { "content-type": "image/png" } }));

    await expect(fetchPage("https://example.com/i.png", LIMITS)).rejects.toThrow(
      "unsupported content type image/png",
    );
  });

  it("reports a timeout", async () => {
    vi.stubGlobal("fetch", hang());

    await expect(fetchPage("https://example.com/slow", { ...LIMITS, timeoutSeconds: 0.05 })).rejects.toThrow(
      "timed out after 0.05 s",
    );
  });

  it("honours an abort signal", async () => {
    vi.stubGlobal("fetch", hang());
    const controller = new AbortController();
    const pending = fetchPage("https://example.com/slow", LIMITS, controller.signal);

    controller.abort();

    await expect(pending).rejects.toThrow("aborted");
  });

  it("reports too many redirects and network errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockRejectedValueOnce(
          new TypeError("fetch failed", { cause: new Error("redirect count exceeded") }),
        ),
    );

    await expect(fetchPage("https://example.com/loop", LIMITS)).rejects.toThrow("too many redirects");

    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockRejectedValueOnce(
          new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND nope.invalid") }),
        ),
    );

    await expect(fetchPage("https://nope.invalid/", LIMITS)).rejects.toThrow(
      "fetch failed: getaddrinfo ENOTFOUND nope.invalid",
    );
  });
});
