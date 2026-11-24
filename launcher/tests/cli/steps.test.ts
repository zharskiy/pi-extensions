import { Writable } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import type { Timers } from "../../cli/prompt/types.ts";
import { ChildFailure, runQuietly, stepsOf } from "../../cli/steps.ts";
import type { CommandRunner } from "../../shared/index.ts";

const streamOf = (tty: boolean) => {
  const chunks: string[] = [];
  const stream = Object.assign(
    new Writable({
      write: (chunk: Buffer | string, _encoding, done) => {
        chunks.push(chunk.toString());

        done();
      },
    }),
    { isTTY: tty, columns: 80 },
  );

  return { stream, text: () => chunks.join("") };
};

const fakeTimers = () => {
  const ticks: Array<() => void> = [];
  const clock = { now: 0 };
  const timers: Timers = {
    now: () => clock.now,
    every: (_ms, tick) => {
      ticks.push(tick);

      return () => ticks.splice(ticks.indexOf(tick), 1);
    },
  };

  const advance = (ms: number) => {
    clock.now += ms;

    ticks.forEach((tick) => {
      tick();
    });
  };

  return { timers, advance };
};

const UTF8 = { LANG: "en_US.UTF-8", TERM: "xterm-256color" };

const setup = (tty: boolean, env: NodeJS.ProcessEnv) => {
  const stdout = streamOf(tty);
  const stderr = streamOf(tty);
  const clock = fakeTimers();
  const steps = stepsOf({ stdout: stdout.stream, stderr: stderr.stream, env }, clock.timers);

  return { steps, stdout, stderr, advance: clock.advance };
};

describe("stepsOf", () => {
  it("prints plain ASCII lines and no pending line off a terminal", async () => {
    const { steps, stdout } = setup(false, UTF8);

    await steps.task({ pending: "Installing colima", done: "Installed colima" }, async () => undefined);

    steps.warn("Left ~/.zshrc as it is");

    steps.close("Pinata is installed.", [
      ["Start", "pi"],
      ["Settings", "~/.config/pinata/config.json"],
    ]);

    expect(stdout.text()).toBe(
      [
        "ok Installed colima",
        "! Left ~/.zshrc as it is",
        "",
        "Pinata is installed.",
        "  Start:     pi",
        "  Settings:  ~/.config/pinata/config.json",
        "",
      ].join("\n"),
    );
    expect(steps.changed()).toBe(true);
  });

  it("prints only the outcome when nothing changed", () => {
    const { steps, stdout } = setup(false, UTF8);

    steps.close("Pinata is already installed. Nothing changed.");

    expect(stdout.text()).toBe("Pinata is already installed. Nothing changed.\n");
    expect(steps.changed()).toBe(false);
  });

  it("continues a row under the value above when its label is empty", () => {
    const { steps, stdout } = setup(false, UTF8);

    steps.close("The sandbox VM is running.", [
      ["Sessions", "~/work/a (0123456789ab, running)"],
      ["", "~/work/b (ba9876543210, exited)"],
    ]);

    expect(stdout.text()).toBe(
      [
        "The sandbox VM is running.",
        "  Sessions:  ~/work/a (0123456789ab, running)",
        "             ~/work/b (ba9876543210, exited)",
        "",
      ].join("\n"),
    );
  });

  it("shows a pending line on a terminal, redraws it with the time taken and replaces it with the done line", async () => {
    const { steps, stdout, advance } = setup(true, { ...UTF8, NO_COLOR: "1" });
    await steps.task({ pending: "Installing colima", done: "Installed colima" }, async () => {
      advance(15_000);
    });

    expect(stdout.text()).toBe(
      [
        "\r\x1b[2K… Installing colima",
        "\r\x1b[2K… Installing colima (15s)",
        "\r\x1b[2K",
        "✔ Installed colima\n",
      ].join(""),
    );
  });

  it("colours the marks on a terminal and never with NO_COLOR", async () => {
    const coloured = setup(true, UTF8);
    const plain = setup(true, { ...UTF8, NO_COLOR: "1" });

    coloured.steps.done("Installed colima");

    plain.steps.done("Installed colima");

    expect(coloured.stdout.text()).toContain("\x1b[");
    expect(stripVTControlCharacters(coloured.stdout.text())).toBe(plain.stdout.text());
    expect(plain.stdout.text()).toBe("✔ Installed colima\n");
  });

  it("prints nothing for a step that changed nothing", async () => {
    const { steps, stdout } = setup(false, UTF8);

    await steps.task(
      { pending: "Stopping", done: (stopped: boolean) => (stopped ? "Stopped" : undefined) },
      async () => false,
    );

    expect(stdout.text()).toBe("");
    expect(steps.changed()).toBe(false);
  });

  it("shows a failing child's command output on stderr and rethrows its failure", async () => {
    const { steps, stdout, stderr } = setup(false, UTF8);
    const output = Array.from({ length: 25 }, (_, line) => `\x1b[31mline ${line}\x1b[0m`).join("\n");
    const runner: CommandRunner = {
      run: async () => ({ code: 2, stdout: `${output}\n`, stderr: "fatal: broke\n" }),
      spawnInteractive: async () => 0,
    };
    const failing = steps.task({ pending: "Installing colima", failed: "Could not install colima" }, () =>
      runQuietly({ runner, home: "/home/me" }, ["brew", "install", "colima"]),
    );

    await expect(failing).rejects.toBeInstanceOf(ChildFailure);

    await expect(failing).rejects.toThrow("brew install colima exited with code 2");
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toBe(
      [
        "x Could not install colima",
        ...Array.from({ length: 19 }, (_, line) => `  line ${line + 6}`),
        "  fatal: broke",
        "",
      ].join("\n"),
    );
  });
});
