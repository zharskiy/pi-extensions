import { describe, expect, it } from "vitest";
import { run, runPinata } from "../../cli/index.ts";
import { LauncherError } from "../../shared/index.ts";
import { createHarness } from "./harness.ts";

describe("error rendering", () => {
  it("prints a LauncherError as one line plus its hint and exits 1", async () => {
    const harness = await createHarness();

    await harness.writeJson(harness.userConfigFile, { backend: "vmware" });

    expect(await run([], harness.deps)).toBe(1);

    const [message, hint, ...rest] = harness.stderr().split("\n");

    expect(message).toMatch(/^pinata: config: backend /);
    expect(hint).toBe(`  hint: fix ${harness.userConfigFile}`);
    expect(rest).toEqual([""]);
  });

  it("prints a LauncherError without a hint as one line", async () => {
    const harness = await createHarness({
      backend: () => {
        throw new LauncherError("engine refused");
      },
    });

    expect(await run([], harness.deps)).toBe(1);
    expect(harness.stderr()).toBe("pinata: engine refused\n");
  });

  it("prints an unexpected error message without a stack and exits 70", async () => {
    const harness = await createHarness({
      backend: () => {
        throw new Error("boom");
      },
    });

    expect(await run([], harness.deps)).toBe(70);
    expect(harness.stderr()).toBe("pinata: unexpected error: boom\n");
  });

  it("refuses an unknown subcommand and points at help", async () => {
    const harness = await createHarness();

    expect(await runPinata(["explode"], harness.deps)).toBe(1);
    expect(harness.stderr()).toBe('pinata: unknown command "pinata explode"\n  hint: pinata help\n');
  });

  it("refuses arguments to a command that takes none and names its usage", async () => {
    const harness = await createHarness();

    expect(await runPinata(["status", "--all"], harness.deps)).toBe(1);
    expect(harness.stderr()).toBe('pinata: unknown status option "--all"\n  hint: pinata status\n');
  });

  it("prints the full help for -h or --help in any position and runs nothing", async () => {
    const reference = await createHarness();
    const harness = await createHarness();

    expect(await runPinata(["help"], reference.deps)).toBe(0);
    expect(await runPinata(["doctor", "--verbose", "--help"], harness.deps)).toBe(0);
    expect(await runPinata(["restart", "-h"], harness.deps)).toBe(0);
    expect(await runPinata(["status", "--help"], harness.deps)).toBe(0);
    expect(harness.stdout()).toBe(reference.stdout().repeat(3));
    expect(harness.stderr()).toBe("");
  });

  it("takes -h for help and no single-letter alias for version", async () => {
    const harness = await createHarness();

    expect(await runPinata(["-v"], harness.deps)).toBe(1);
    expect(await runPinata(["-h"], harness.deps)).toBe(0);
    expect(harness.stdout()).toMatch(/^pi \[args\.\.\.\] {2,}run pi in the sandbox/);
  });

  it("no longer has a gc command", async () => {
    const harness = await createHarness();

    expect(await runPinata(["gc"], harness.deps)).toBe(1);
    expect(harness.stderr()).toContain('pinata: unknown command "pinata gc"');
  });

  it("renders a failure of either entry point with the pinata prefix", async () => {
    const harness = await createHarness({
      backend: () => {
        throw new Error("boom");
      },
    });

    expect(await runPinata(["status"], harness.deps)).toBe(70);
    expect(await run([], harness.deps)).toBe(70);
    expect(harness.stderr()).toBe("pinata: unexpected error: boom\npinata: unexpected error: boom\n");
  });
});
