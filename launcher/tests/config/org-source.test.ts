import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, get, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createHttpsFetchText,
  type HttpsGet,
  httpsFetchText,
  loadOrgLayer,
  orgBaselineStatus,
} from "../../config/org-source.ts";
import type { OrgRef } from "../../config/types.ts";
import { sha256Hex, stateLayout } from "../../shared/index.ts";
import { createFakeClock } from "../support/fake-clock.ts";
import { createFakeFetchText } from "../support/fake-fetch.ts";

const URL_SOURCE = "https://config.example.internal/pi/baseline.json?token=hunter2";

const HOUR_MS = 3_600_000;

const BASELINE = JSON.stringify({ fallback: "refuse", egress: { allow: ["github.com"] } });

const NEWER = JSON.stringify({ fallback: "refuse", egress: { allow: [] } });

const ok = (body: string) => ({ status: 200, body });

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const setup = async (routes: Parameters<typeof createFakeFetchText>[0] = { [URL_SOURCE]: ok(BASELINE) }) => {
  const stateDir = await mkdtemp(join(tmpdir(), "pi-sandbox-org-"));
  const fake = createFakeFetchText(routes);
  const clock = createFakeClock();

  created.push(stateDir);

  const load = (ref: Partial<OrgRef> = {}) =>
    loadOrgLayer({
      ref: { source: URL_SOURCE, ...ref },
      stateDir,
      fetchText: fake.fetchText,
      now: clock.now,
    });

  return { stateDir, fake, clock, load };
};

describe("loadOrgLayer from an HTTPS source", () => {
  it("fetches the baseline with a 3 s timeout and validates it as the org layer", async () => {
    const { fake, load } = await setup();

    await expect(load()).resolves.toEqual({
      layer: { fallback: "refuse", egress: { allow: ["github.com"] } },
      notices: [],
    });
    expect(fake.calls).toEqual([{ url: URL_SOURCE, timeoutMs: 3000 }]);
  });

  it("uses the cache within the refresh interval and refetches after it", async () => {
    const { fake, clock, load } = await setup();

    await load();

    fake.route(URL_SOURCE, ok(NEWER));

    clock.advance(23 * HOUR_MS);

    await expect(load()).resolves.toMatchObject({ layer: { egress: { allow: ["github.com"] } } });
    expect(fake.calls).toHaveLength(1);

    clock.advance(2 * HOUR_MS);

    await expect(load()).resolves.toMatchObject({ layer: { egress: { allow: [] } }, notices: [] });
    expect(fake.calls).toHaveLength(2);
  });

  it("honours refreshHours", async () => {
    const { fake, clock, load } = await setup();

    await load({ refreshHours: 1 });

    clock.advance(2 * HOUR_MS);

    await load({ refreshHours: 1 });

    expect(fake.calls).toHaveLength(2);
  });

  it("falls back to the cache with a notice when the fetch fails, without leaking the query", async () => {
    const { fake, clock, load } = await setup();

    await load();

    fake.route(URL_SOURCE, new Error("connect ECONNREFUSED"));

    clock.advance(25 * HOUR_MS);

    const result = await load();

    expect(result.layer).toEqual({ fallback: "refuse", egress: { allow: ["github.com"] } });
    expect(result.notices).toHaveLength(1);
    expect(result.notices[0]).toContain(
      "could not fetch the baseline from https://config.example.internal/pi/baseline.json",
    );
    expect(result.notices[0]).toContain("ECONNREFUSED");
    expect(result.notices[0]).toContain("2026-01-01T00:00:00.000Z");
    expect(result.notices[0]).not.toContain("hunter2");

    fake.route(URL_SOURCE, { status: 503, body: "" });

    clock.advance(HOUR_MS);

    await expect(load()).resolves.toMatchObject({ notices: [expect.stringContaining("HTTP 503")] });
  });

  it("retries a failed refresh at most once an hour and prints the notice once per failed attempt", async () => {
    const { fake, clock, load } = await setup();

    await load();

    fake.route(URL_SOURCE, new Error("getaddrinfo ENOTFOUND"));

    clock.advance(25 * HOUR_MS);

    expect((await load()).notices).toHaveLength(1);

    clock.advance(HOUR_MS - 1);

    await expect(load()).resolves.toEqual({
      layer: { fallback: "refuse", egress: { allow: ["github.com"] } },
      notices: [],
    });
    expect(fake.calls).toHaveLength(2);

    clock.advance(1);

    expect((await load()).notices).toHaveLength(1);
    expect(fake.calls).toHaveLength(3);

    fake.route(URL_SOURCE, ok(NEWER));

    clock.advance(HOUR_MS);

    await expect(load()).resolves.toEqual({
      layer: { fallback: "refuse", egress: { allow: [] } },
      notices: [],
    });
    expect(fake.calls).toHaveLength(4);
  });

  it("refuses a response larger than 1 MiB", async () => {
    const huge = JSON.stringify({ fallback: "refuse", pad: "x".repeat(1_048_576) });
    const { load } = await setup({ [URL_SOURCE]: ok(huge) });

    await expect(load()).rejects.toThrow(/^org: response larger than 1 MiB$/);
  });

  it("offline, uses any cached copy and skips the layer without one, never fetching", async () => {
    const { fake, clock, stateDir } = await setup();
    const offline = () =>
      loadOrgLayer({
        ref: { source: URL_SOURCE },
        stateDir,
        fetchText: fake.fetchText,
        now: clock.now,
        offline: true,
      });

    await expect(offline()).resolves.toEqual({
      layer: undefined,
      notices: [
        "org: no cached baseline from https://config.example.internal/pi/baseline.json; the org layer is skipped",
      ],
    });

    await loadOrgLayer({ ref: { source: URL_SOURCE }, stateDir, fetchText: fake.fetchText, now: clock.now });

    clock.advance(100 * HOUR_MS);

    await expect(offline()).resolves.toMatchObject({ layer: { fallback: "refuse" }, notices: [] });
    expect(fake.calls).toHaveLength(1);
  });

  it("refuses to start when the fetch fails and there is no cache", async () => {
    const { load } = await setup({ [URL_SOURCE]: new Error("connect ETIMEDOUT") });

    await expect(load()).rejects.toThrow(/^org: could not fetch the baseline .*ETIMEDOUT/);
  });

  it("accepts a baseline matching the pinned sha256", async () => {
    const { load } = await setup();

    await expect(load({ sha256: sha256Hex(BASELINE) })).resolves.toMatchObject({
      layer: { fallback: "refuse" },
      notices: [],
    });
  });

  it("refuses a sha256 mismatch without a valid cache", async () => {
    const { load } = await setup();

    await expect(load({ sha256: "0".repeat(64) })).rejects.toThrow("does not match the pinned sha256");
  });

  it("keeps the pinned cache with a notice when a refresh does not match the pin", async () => {
    const { fake, clock, load } = await setup();
    const pin = { sha256: sha256Hex(BASELINE) };

    await load(pin);

    fake.route(URL_SOURCE, ok(NEWER));

    clock.advance(25 * HOUR_MS);

    await expect(load(pin)).resolves.toEqual({
      layer: { fallback: "refuse", egress: { allow: ["github.com"] } },
      notices: [expect.stringContaining("does not match the pinned sha256")],
    });
  });

  it("ignores a cache written for another source", async () => {
    const { fake, load } = await setup();
    const other = "https://config.example.internal/other.json";

    await load();

    fake.route(other, ok(NEWER));

    await expect(load({ source: other })).resolves.toMatchObject({ layer: { egress: { allow: [] } } });
  });

  it("refuses an invalid baseline with a message naming the layer", async () => {
    const { load } = await setup({ [URL_SOURCE]: ok(JSON.stringify({ ports: [3000] })) });

    await expect(load()).rejects.toThrow("org: ports is not a known key");
  });

  it("refuses a baseline that sets org itself", async () => {
    const nested = JSON.stringify({ org: { source: "https://config.example.internal/x.json" } });
    const { load } = await setup({ [URL_SOURCE]: ok(nested) });

    await expect(load()).rejects.toThrow("org: org may only be set by the policy or user config");
  });

  it("refuses a baseline that is not JSON", async () => {
    const { load } = await setup({ [URL_SOURCE]: ok("{ nope") });

    await expect(load()).rejects.toThrow("org: invalid JSON");
  });
});

describe("loadOrgLayer from a file source", () => {
  it("reads the file every time and verifies the pin", async () => {
    const { stateDir, fake, load } = await setup();
    const file = join(stateDir, "baseline.json");

    await writeFile(file, BASELINE);

    await expect(load({ source: file })).resolves.toMatchObject({ layer: { fallback: "refuse" } });

    await writeFile(file, NEWER);

    await expect(load({ source: file })).resolves.toMatchObject({ layer: { egress: { allow: [] } } });
    await expect(load({ source: file, sha256: sha256Hex(NEWER) })).resolves.toMatchObject({ notices: [] });
    await expect(load({ source: file, sha256: sha256Hex(BASELINE) })).rejects.toThrow(
      "does not match the pinned sha256",
    );
    expect(fake.calls).toEqual([]);
  });

  it("expands a leading ~/ to the home directory", async () => {
    const { stateDir, clock, fake } = await setup();

    await writeFile(join(stateDir, "baseline.json"), BASELINE);

    await expect(
      loadOrgLayer({
        ref: { source: "~/baseline.json" },
        stateDir,
        fetchText: fake.fetchText,
        now: clock.now,
        home: stateDir,
      }),
    ).resolves.toMatchObject({ layer: { fallback: "refuse" } });
  });

  it("names the missing file", async () => {
    const { stateDir, load } = await setup();
    const file = join(stateDir, "missing.json");

    await expect(load({ source: file })).rejects.toThrow(`org: cannot read ${file}`);
  });
});

describe("httpsFetchText", () => {
  it("refuses a plain HTTP URL", async () => {
    await expect(httpsFetchText("http://config.example.internal/x.json", { timeoutMs: 100 })).rejects.toThrow(
      "only HTTPS URLs are fetched",
    );
  });
});

const selfSignedCertificate = async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-sandbox-org-cert-"));
  const key = join(dir, "key.pem");
  const cert = join(dir, "cert.pem");

  await promisify(execFile)("openssl", [
    "req",
    "-x509",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:prime256v1",
    "-nodes",
    "-keyout",
    key,
    "-out",
    cert,
    "-days",
    "1",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=IP:127.0.0.1",
  ]);

  const pair = { key: await readFile(key, "utf8"), cert: await readFile(cert, "utf8") };

  await rm(dir, { recursive: true, force: true });

  return pair;
};

const ONE_MIB = 1_048_576;

describe("httpsFetchText against a local HTTPS server", () => {
  const local = { server: undefined as Server | undefined, origin: "", fetchText: httpsFetchText };

  beforeAll(async () => {
    const certificate = await selfSignedCertificate();
    const server = createServer(certificate, (request, response) => {
      const path = request.url ?? "/";
      const hops = /^\/hops\/(\d+)$/.exec(path);

      if (hops !== null) {
        const left = Number(hops[1]);

        response.writeHead(left === 0 ? 200 : 302, left === 0 ? {} : { location: `/hops/${left - 1}` });

        response.end(left === 0 ? "arrived" : "");

        return;
      }

      if (path === "/to-http") {
        response.writeHead(302, { location: `http://127.0.0.1:${(server.address() as AddressInfo).port}/x` });

        response.end();

        return;
      }

      if (path === "/huge") {
        response.writeHead(200);

        response.write(Buffer.alloc(ONE_MIB + 1, "x"));
      }
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    const testGet: HttpsGet = (url, options, callback) =>
      get(url, { ...options, ca: [certificate.cert] }, callback);

    local.server = server;
    local.origin = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
    local.fetchText = createHttpsFetchText(testGet);
  });

  afterAll(async () => {
    local.server?.closeAllConnections();

    await new Promise((resolve) => local.server?.close(resolve));
  });

  const fetchPath = (path: string, timeoutMs = 2000) =>
    local.fetchText(`${local.origin}${path}`, { timeoutMs });

  it("follows up to 3 redirects and refuses a fourth", async () => {
    await expect(fetchPath("/hops/3")).resolves.toEqual({ status: 200, body: "arrived" });
    await expect(fetchPath("/hops/4")).rejects.toThrow("more than 3 redirects");
  });

  it("refuses a redirect from HTTPS to plain HTTP", async () => {
    await expect(fetchPath("/to-http")).rejects.toThrow("only HTTPS URLs are fetched");
  });

  it("stops reading a body once it passes 1 MiB, without waiting for its end", async () => {
    await expect(fetchPath("/huge")).rejects.toThrow(/^org: response larger than 1 MiB$/);
  });

  it("names the timeout when the server does not answer", async () => {
    await expect(fetchPath("/silent", 200)).rejects.toThrow("timed out after 200 ms");
  });

  it("does not trust a server outside the system and default CA stores", async () => {
    await expect(httpsFetchText(`${local.origin}/hops/0`, { timeoutMs: 2000 })).rejects.toThrow();
  });
});

describe("orgBaselineStatus", () => {
  const SHOWN = "https://config.example.internal/pi/baseline.json";

  it("reports a URL source that has never been fetched, without the query", async () => {
    const { stateDir, clock } = await setup();

    await expect(
      orgBaselineStatus({ ref: { source: URL_SOURCE }, stateDir, now: clock.now }),
    ).resolves.toEqual({
      ok: false,
      message: `${SHOWN} has not been fetched`,
    });
  });

  it("reports the age and hash of an intact cached copy", async () => {
    const { stateDir, clock, load } = await setup();

    await load();

    clock.advance(2 * HOUR_MS + 1);

    await expect(
      orgBaselineStatus({ ref: { source: URL_SOURCE }, stateDir, now: clock.now }),
    ).resolves.toEqual({
      ok: true,
      message: `${SHOWN} fetched 2 h ago, sha256 ${sha256Hex(BASELINE).slice(0, 12)}`,
    });
  });

  it("tells a changed source, a damaged copy and a pin mismatch apart", async () => {
    const { stateDir, clock, load } = await setup();
    const status = (ref: OrgRef) => orgBaselineStatus({ ref, stateDir, now: clock.now });

    await load();

    await expect(status({ source: "https://config.example.internal/other.json" })).resolves.toEqual({
      ok: false,
      message: "https://config.example.internal/other.json has not been fetched since org.source changed",
    });
    await expect(status({ source: URL_SOURCE, sha256: "0".repeat(64) })).resolves.toEqual({
      ok: false,
      message: `${SHOWN} has a cached copy that does not match the pinned sha256`,
    });

    await writeFile(stateLayout(stateDir).orgBaseline, NEWER);

    await expect(status({ source: URL_SOURCE })).resolves.toEqual({
      ok: false,
      message: `${SHOWN} has a damaged cached copy`,
    });
  });

  it("checks a file source directly: readable, pinned and valid", async () => {
    const { stateDir, clock } = await setup();
    const file = join(stateDir, "baseline.json");
    const status = (ref: Partial<OrgRef> = {}) =>
      orgBaselineStatus({ ref: { source: file, ...ref }, stateDir, now: clock.now });

    await expect(status()).resolves.toEqual({ ok: false, message: `cannot read ${file}` });

    await writeFile(file, BASELINE);

    await expect(status()).resolves.toEqual({
      ok: true,
      message: `${file}, sha256 ${sha256Hex(BASELINE).slice(0, 12)}`,
    });
    await expect(status({ sha256: "0".repeat(64) })).resolves.toEqual({
      ok: false,
      message: `${file} does not match the pinned sha256`,
    });

    await writeFile(file, JSON.stringify({ ports: [3000] }));

    await expect(status()).resolves.toEqual({
      ok: false,
      message: `${file}: org: ports is not a known key`,
    });
  });
});
