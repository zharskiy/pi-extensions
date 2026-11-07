import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { httpsFetchText, loadOrgLayer } from "../../config/org-source.ts";
import type { OrgRef } from "../../config/types.ts";
import { sha256Hex } from "../../shared/index.ts";
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
