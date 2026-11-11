import { describe, expect, it } from "vitest";
import { run } from "../../cli/index.ts";
import { LauncherError } from "../../shared/index.ts";
import { createHarness } from "./harness.ts";

describe("error rendering", () => {
  it("prints a LauncherError as one line plus its hint and exits 1", async () => {
    const harness = await createHarness();

    await harness.writeJson(harness.userConfigFile, { backend: "vmware" });

    expect(await run([], harness.deps)).toBe(1);

    const [message, hint, ...rest] = harness.stderr().split("\n");

    expect(message).toMatch(/^pi-sandbox: user: backend /);
    expect(hint).toBe(`  hint: fix ${harness.userConfigFile}`);
    expect(rest).toEqual([""]);
  });

  it("prints a LauncherError without a hint as one line", async () => {
    const harness = await createHarness({
      backend: () => {
        throw new LauncherError("engine refused");
      },
    });

    await harness.writeJson(harness.userConfigFile, { fallback: "refuse" });

    expect(await run([], harness.deps)).toBe(1);
    expect(harness.stderr()).toBe("pi-sandbox: engine refused\n");
  });

  it("prints an unexpected error message without a stack and exits 70", async () => {
    const harness = await createHarness({
      backend: () => {
        throw new Error("boom");
      },
    });

    expect(await run([], harness.deps)).toBe(70);
    expect(harness.stderr()).toBe("pi-sandbox: unexpected error: boom\n");
  });

  it("refuses an unknown subcommand and points at help", async () => {
    const harness = await createHarness();

    expect(await run(["sandbox", "explode"], harness.deps)).toBe(1);
    expect(harness.stderr()).toBe(
      'pi-sandbox: unknown command "pi sandbox explode"\n  hint: pi sandbox help\n',
    );
  });

  it("refuses arguments to a command that takes none and names its usage", async () => {
    const harness = await createHarness();

    expect(await run(["sandbox", "status", "--all"], harness.deps)).toBe(1);
    expect(harness.stderr()).toBe('pi-sandbox: unknown status option "--all"\n  hint: pi sandbox status\n');
  });

  it("prints a command's usage for -h or --help in any position and runs nothing", async () => {
    const harness = await createHarness();

    expect(await run(["sandbox", "config", "--json", "--help"], harness.deps)).toBe(0);
    expect(await run(["sandbox", "reset", "-h"], harness.deps)).toBe(0);
    expect(await run(["sandbox", "status", "--help"], harness.deps)).toBe(0);
    expect(harness.stdout()).toBe(
      ["usage: pi sandbox config [--json]", "usage: pi sandbox reset", "usage: pi sandbox status", ""].join(
        "\n",
      ),
    );
    expect(harness.stderr()).toBe("");
  });

  it("takes no single-letter aliases for help and version", async () => {
    const harness = await createHarness();

    expect(await run(["sandbox", "-v"], harness.deps)).toBe(1);
    expect(await run(["sandbox", "-h"], harness.deps)).toBe(1);
  });

  it("refuses an unknown reset option and names its usage", async () => {
    const harness = await createHarness();

    expect(await run(["sandbox", "reset", "--volumes"], harness.deps)).toBe(1);
    expect(harness.stderr()).toBe('pi-sandbox: unknown reset option "--volumes"\n  hint: pi sandbox reset\n');
  });

  it("no longer has a gc command", async () => {
    const harness = await createHarness();

    expect(await run(["sandbox", "gc"], harness.deps)).toBe(1);
    expect(harness.stderr()).toContain('unknown command "pi sandbox gc"');
  });
});
