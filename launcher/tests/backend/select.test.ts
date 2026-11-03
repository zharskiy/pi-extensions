import { describe, expect, it } from "vitest";
import { type Backend, type BackendName, createDefaultAdapters, selectBackend } from "../../backend/index.ts";
import type { Detection } from "../../backend/types.ts";
import { LauncherError } from "../../shared/index.ts";
import { createFakeRunner } from "../support/fake-runner.ts";

const stubBackend = (name: BackendName, detection: Detection) =>
  ({ name, detect: async () => detection }) as Backend;

const colima = stubBackend("colima", { available: true, version: "27" });

const apple = stubBackend("apple", { available: true, version: "0.9" });

const colimaDown = stubBackend("colima", { available: false, reason: "socket missing" });

const appleDown = stubBackend("apple", { available: false, reason: "container: command not found" });

describe("selectBackend", () => {
  it("prefers colima on auto", async () => {
    expect(await selectBackend("auto", [apple, colima])).toBe(colima);
  });

  it("falls back to apple on auto when colima is unavailable", async () => {
    expect(await selectBackend("auto", [colimaDown, apple])).toBe(apple);
  });

  it("uses only the explicitly chosen backend", async () => {
    expect(await selectBackend("apple", [colima, apple])).toBe(apple);

    await expect(selectBackend("colima", [colimaDown, apple])).rejects.toThrow(
      "no sandbox backend available: colima (socket missing)",
    );
  });

  it("lists every backend it tried and why when none is available", async () => {
    const refused = selectBackend("auto", [colimaDown, appleDown]);

    await expect(refused).rejects.toBeInstanceOf(LauncherError);
    await expect(refused).rejects.toThrow(
      "no sandbox backend available: colima (socket missing); apple (container: command not found)",
    );
  });

  it("names a backend without an adapter", async () => {
    await expect(selectBackend("auto", [])).rejects.toThrow(
      "colima (no adapter on this host); apple (no adapter on this host)",
    );
  });
});

describe("createDefaultAdapters", () => {
  it("creates colima over the resolved socket and apple over the runner", async () => {
    const adapters = createDefaultAdapters({
      runner: createFakeRunner(() => undefined).runner,
      env: { DOCKER_HOST: "unix:///nonexistent/pi-sandbox-test.sock" },
      home: "/nonexistent",
    });

    expect(adapters.map((adapter) => adapter.name)).toEqual(["colima", "apple"]);
    expect((await adapters[0]?.status())?.socket).toBe("/nonexistent/pi-sandbox-test.sock");
  });
});
