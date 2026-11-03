import { afterEach, describe, expect, it } from "vitest";
import { run } from "../../cli/index.ts";
import { LauncherError } from "../../shared/index.ts";
import { createHarness } from "./harness.ts";

const harnesses: Array<{ cleanup(): Promise<void> }> = [];

const harnessWith = async (options: Parameters<typeof createHarness>[0] = {}) => {
  const harness = await createHarness(options);

  harnesses.push(harness);

  return harness;
};

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.cleanup()));
});

describe("error rendering", () => {
  it("prints a LauncherError as one line plus its hint and exits 1", async () => {
    const harness = await harnessWith();

    await harness.writeJson(harness.userConfigFile, { backend: "vmware" });

    expect(await run([], harness.deps)).toBe(1);

    const [message, hint, ...rest] = harness.stderr().split("\n");

    expect(message).toMatch(/^pi-sandbox: user: backend /);
    expect(hint).toBe(`  hint: fix ${harness.userConfigFile}`);
    expect(rest).toEqual([""]);
  });

  it("prints a LauncherError without a hint as one line", async () => {
    const harness = await harnessWith({
      adapters: () => {
        throw new LauncherError("engine refused");
      },
    });

    await harness.writeJson(harness.userConfigFile, { fallback: "refuse" });

    expect(await run([], harness.deps)).toBe(1);
    expect(harness.stderr()).toBe("pi-sandbox: engine refused\n");
  });

  it("prints an unexpected error message without a stack and exits 70", async () => {
    const harness = await harnessWith({
      adapters: () => {
        throw new Error("boom");
      },
    });

    expect(await run([], harness.deps)).toBe(70);
    expect(harness.stderr()).toBe("pi-sandbox: unexpected error: boom\n");
  });

  it("refuses an unknown subcommand and points at help", async () => {
    const harness = await harnessWith();

    expect(await run(["sandbox", "explode"], harness.deps)).toBe(1);
    expect(harness.stderr()).toBe(
      'pi-sandbox: unknown command "pi sandbox explode"\n  hint: pi sandbox help\n',
    );
  });

  it("refuses arguments to a command that takes none", async () => {
    const harness = await harnessWith();

    expect(await run(["sandbox", "gc", "--all"], harness.deps)).toBe(1);
    expect(harness.stderr()).toContain("pi sandbox gc takes no arguments");
  });
});
