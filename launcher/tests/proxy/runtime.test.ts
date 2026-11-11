import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProxyRuntime } from "../../proxy/runtime.ts";
import { stateLayout } from "../../shared/index.ts";
import { settingsOf } from "./harness.ts";

const REPO = "1".repeat(64);

const state = { stateDir: "" };

const egressPath = () => stateLayout(state.stateDir).repo(REPO).proxy.egress;

const runtimeWith = (allow: string[]) =>
  createProxyRuntime({
    stateDir: state.stateDir,
    repoHash: REPO,
    rules: [],
    settings: settingsOf({ allow }),
  });

beforeEach(async () => {
  state.stateDir = await mkdtemp(join(tmpdir(), "pi-sandbox-runtime-"));

  await mkdir(dirname(egressPath()), { recursive: true });
});

afterEach(async () => {
  await chmod(egressPath(), 0o600).catch(() => undefined);

  await rm(state.stateDir, { recursive: true, force: true });
});

describe("live egress settings", () => {
  it("retries a failed read at the next call and picks up the file without another change", async () => {
    const runtime = runtimeWith(["old.test"]);

    await writeFile(egressPath(), JSON.stringify(settingsOf({ allow: ["new.test"] })));

    await chmod(egressPath(), 0o000);

    expect((await runtime.egress()).settings.allow).toEqual(["old.test"]);

    await chmod(egressPath(), 0o600);

    expect((await runtime.egress()).settings.allow).toEqual(["new.test"]);
  });

  it("shares one read between calls that arrive while it runs", async () => {
    const runtime = runtimeWith(["old.test"]);

    await writeFile(egressPath(), JSON.stringify(settingsOf({ allow: ["new.test"] })));

    const [first, second] = await Promise.all([runtime.egress(), runtime.egress()]);

    expect(first.settings).toBe(second.settings);
    expect(first.settings.allow).toEqual(["new.test"]);
  });

  it("keeps the last good settings when the file is garbled", async () => {
    const runtime = runtimeWith(["old.test"]);

    await writeFile(egressPath(), JSON.stringify(settingsOf({ allow: ["new.test"] })));

    expect((await runtime.egress()).settings.allow).toEqual(["new.test"]);

    await writeFile(egressPath(), "{ not json");

    expect((await runtime.egress()).settings.allow).toEqual(["new.test"]);
  });

  it("reads an egress.json written before derived private hosts existed as having none", async () => {
    const runtime = runtimeWith(["old.test"]);
    const { derivedPrivateHosts: _dropped, ...older } = settingsOf({ allow: ["new.test"] });

    await writeFile(egressPath(), JSON.stringify(older));

    expect((await runtime.egress()).settings).toMatchObject({ allow: ["new.test"], derivedPrivateHosts: [] });
  });
});
