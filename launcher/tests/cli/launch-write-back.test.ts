import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../../cli/index.ts";
import { createFakeBackend, createHarness, isPiSession } from "./harness.ts";

type Edit = (write: (name: string, value: unknown) => Promise<void>) => Promise<void>;

const setup = async () => {
  const session: { edit?: Edit } = {};
  const fake = createFakeBackend({
    exec: async (spec) => {
      if (!isPiSession(spec)) {
        return undefined;
      }

      await session.edit?.((name, value) => fake.writeGuestFile(name, JSON.stringify(value)));

      return 0;
    },
  });
  const harness = await createHarness({ backend: () => fake.backend });
  const host = async (name: string) =>
    JSON.parse(await readFile(join(harness.hostAgentDir, name), "utf8").catch(() => "null"));
  const launchWith = async (edit?: Edit) => {
    session.edit = edit;

    const before = harness.stderr().length;
    const code = await run([], harness.deps);

    return { code, stderr: harness.stderr().slice(before) };
  };

  return { fake, harness, host, launchWith };
};

const WRITTEN = "pi-sandbox: settings.json defaultModel: p/a → p/b written to the host";

describe("writing sandbox settings back to the host", () => {
  it("writes nothing back at the first launch, then writes the session's change back at exit", async () => {
    const env = await setup();

    await env.harness.writeJson(join(env.harness.hostAgentDir, "settings.json"), {
      defaultModel: "p/a",
      packages: ["npm:a"],
    });

    await env.fake.writeGuestFile("settings.json", JSON.stringify({ defaultModel: "p/stale" }));

    const { code, stderr } = await env.launchWith((write) =>
      write("settings.json", { defaultModel: "p/b", packages: ["npm:planted"] }),
    );

    expect(code).toBe(0);
    expect(stderr.split("\n").filter((line) => line.includes("written to the host"))).toEqual([WRITTEN]);
    expect(await env.host("settings.json")).toEqual({ defaultModel: "p/b", packages: ["npm:a"] });
  });

  it("prints nothing when the session changed nothing, and a second session builds on the first", async () => {
    const env = await setup();

    await env.harness.writeJson(join(env.harness.hostAgentDir, "pi-style.json"), { style: "plain" });

    expect((await env.launchWith()).stderr).not.toContain("written to the host");

    const second = await env.launchWith((write) => write("pi-style.json", { style: "terse" }));

    expect(second.stderr).toContain("pi-sandbox: pi-style.json style: plain → terse written to the host");
    expect(await env.host("pi-style.json")).toEqual({ style: "terse" });
  });

  it("recovers a change left in the volume by a killed session at the next launch", async () => {
    const env = await setup();

    await env.harness.writeJson(join(env.harness.hostAgentDir, "settings.json"), { defaultModel: "p/a" });

    await env.launchWith();

    await env.fake.writeGuestFile("settings.json", JSON.stringify({ defaultModel: "p/b" }));

    const next = await env.launchWith(async () => {
      expect(await env.host("settings.json")).toEqual({ defaultModel: "p/b" });
    });

    expect(next.stderr).toContain(WRITTEN);
  });

  it("writes a live session's change back before the doctor refreshes the shared volume", async () => {
    const env = await setup();

    await env.harness.writeJson(join(env.harness.hostAgentDir, "settings.json"), { defaultModel: "p/a" });

    await env.launchWith();

    await env.fake.writeGuestFile("settings.json", JSON.stringify({ defaultModel: "p/b" }));

    await run(["sandbox", "doctor"], env.harness.deps);

    expect(env.harness.stdout()).toContain("settings.json defaultModel: p/a → p/b written to the host");
    expect(await env.host("settings.json")).toEqual({ defaultModel: "p/b" });
    expect(JSON.parse((await env.fake.guestFile("settings.json")) ?? "null")).toMatchObject({
      defaultModel: "p/b",
    });
  });

  it("keeps the host value when the host changed the same key during the session", async () => {
    const env = await setup();
    const settings = join(env.harness.hostAgentDir, "settings.json");

    await env.harness.writeJson(settings, { defaultModel: "p/a" });

    const { stderr } = await env.launchWith(async (write) => {
      await write("settings.json", { defaultModel: "p/b" });

      await env.harness.writeJson(settings, { defaultModel: "p/c" });
    });

    expect(stderr).toContain(
      "pi-sandbox: settings.json: defaultModel changed on the host and in the sandbox; kept the host value",
    );
    expect(await env.host("settings.json")).toEqual({ defaultModel: "p/c" });
  });

  it("keeps pi's exit code when the write-back fails", async () => {
    const env = await setup();

    await env.harness.writeJson(join(env.harness.hostAgentDir, "settings.json"), { defaultModel: "p/a" });

    const session: { failing: boolean } = { failing: false };
    const backend = env.fake.backend;
    const exec = backend.exec;

    backend.exec = async (spec, io) => {
      if (session.failing && !isPiSession(spec)) {
        return 1;
      }

      const code = await exec(spec, io);

      session.failing = isPiSession(spec);

      return isPiSession(spec) ? 5 : code;
    };

    const { code, stderr } = await env.launchWith();

    expect(code).toBe(5);
    expect(stderr).toContain("pi-sandbox: warning: settings.json was not written back");
    expect(await env.host("settings.json")).toEqual({ defaultModel: "p/a" });
  });
});
