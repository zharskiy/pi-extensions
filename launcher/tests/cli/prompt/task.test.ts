import { describe, expect, it } from "vitest";
import { fakeTimers, KEY, outcome, pause, plainPrompts, press, richPrompts } from "./fake-tty.ts";

const WARNING =
  "The VM is still starting. Press ctrl-c again to stop waiting; your settings are already saved.";

const deferred = <T>() => {
  const handle = { resolve: (_value: T) => {}, reject: (_error: unknown) => {} };

  const promise = new Promise<T>((resolve, reject) => {
    handle.resolve = resolve;
    handle.reject = reject;
  });

  return { promise, ...handle };
};

describe("task", () => {
  it("advances the spinner every 100 ms and shows the update text with the elapsed time", async () => {
    const clock = fakeTimers();
    const { prompts, screen, input } = richPrompts({ timers: clock.timers });
    const work = deferred<string>();

    const reply = prompts.task({
      title: "Sandbox VM",
      interruptWarning: WARNING,
      run: (update) => {
        update("Creating the VM…");

        return work.promise;
      },
    });

    await pause();

    expect(screen.lines()).toEqual(["◆  Sandbox VM", "│  ◐ Creating the VM… 0s", "│  ctrl-c stops waiting"]);

    expect(screen.flags().cursorHidden).toBe(true);

    expect(input.isRaw).toBe(true);

    clock.advance(100);

    expect(screen.lines()).toContain("│  ◓ Creating the VM… 0s");

    clock.advance(65_000);

    expect(screen.lines()[1]).toMatch(/^│ {2}. Creating the VM… 1m 05s$/);

    work.resolve("done");

    expect(await reply).toBe("done");

    expect(screen.lines()).toEqual([]);

    expect(clock.live()).toBe(0);

    expect(screen.flags().cursorHidden).toBe(false);

    expect(input.rawCalls.at(-1)).toBe(false);
  });

  it("warns on the first ctrl-c and rejects on the second while run keeps going", async () => {
    const clock = fakeTimers();
    const { prompts, screen, input } = richPrompts({ timers: clock.timers });
    const work = deferred<string>();
    const state = { finished: false };

    const reply = outcome(
      prompts.task({
        title: "Sandbox VM",
        interruptWarning: WARNING,
        run: async () => {
          await work.promise;

          state.finished = true;

          return "late";
        },
      }),
    );

    await press(input, KEY.ctrlC);

    expect(screen.lines()).toEqual([
      "◆  Sandbox VM",
      "│  ◐ 0s",
      "│  ▲ The VM is still starting. Press ctrl-c again to stop waiting; your",
      "│    settings are already saved.",
    ]);

    await press(input, KEY.ctrlC);

    expect((await reply).error).toMatchObject({ cause: "interrupt" });

    expect(clock.live()).toBe(0);

    work.resolve("ok");

    await pause();

    expect(state.finished).toBe(true);
  });

  it("rejects with the run's error and clears the timer", async () => {
    const clock = fakeTimers();
    const { prompts } = richPrompts({ timers: clock.timers });

    const reply = outcome(
      prompts.task({
        title: "",
        interruptWarning: "",
        run: async () => {
          throw new Error("colima failed");
        },
      }),
    );

    expect((await reply).error).toEqual(new Error("colima failed"));

    expect(clock.live()).toBe(0);
  });

  it("draws only the spinner line without a title, and cancels at once without a warning", async () => {
    const clock = fakeTimers();
    const { prompts, screen, input } = richPrompts({ timers: clock.timers });

    const reply = outcome(
      prompts.task({
        title: "",
        interruptWarning: "",
        run: (update) => {
          update("Checking this Mac and the sandbox VM…");

          return new Promise<void>(() => undefined);
        },
      }),
    );

    await pause();

    expect(screen.lines()).toEqual(["│  ◐ Checking this Mac and the sandbox VM… 0s"]);

    await press(input, KEY.ctrlC);

    expect((await reply).error).toMatchObject({ cause: "interrupt" });
  });

  it("prints plain lines per update and a heartbeat every 15 s", async () => {
    const clock = fakeTimers();
    const { prompts, screen } = plainPrompts({ timers: clock.timers });
    const work = deferred<number>();

    const reply = prompts.task({
      title: "Sandbox VM",
      interruptWarning: WARNING,
      run: (update) => {
        update("Creating the VM…");

        update("Creating the VM…");

        return work.promise;
      },
    });

    await pause();

    clock.advance(46_000);

    work.resolve(54);

    expect(await reply).toBe(54);

    expect(screen.lines()).toEqual([
      "Creating the VM...",
      "  still working (15s)",
      "  still working (30s)",
      "  still working (45s)",
    ]);

    expect(clock.live()).toBe(0);
  });

  it("takes ctrl-c as a key in plain mode too, warning first", async () => {
    const { prompts, screen, input } = plainPrompts({ timers: fakeTimers().timers });
    const reply = outcome(
      prompts.task({ title: "", interruptWarning: WARNING, run: () => new Promise(() => undefined) }),
    );

    await press(input, KEY.ctrlC);

    expect(screen.lines().join("")).toBe(`Warning: ${WARNING}`);

    await press(input, KEY.ctrlC);

    expect((await reply).error).toMatchObject({ cause: "interrupt" });

    expect(input.rawCalls).toEqual([true, false]);
  });

  it("ends without running the job once the session is closed, in both modes", async () => {
    const fakes = [richPrompts(), plainPrompts()];
    const runs: string[] = [];

    const replies = fakes.map((fake) => {
      fake.ui.session.restore();

      return outcome(
        fake.prompts.task({
          title: "Sandbox VM",
          interruptWarning: WARNING,
          run: async () => {
            runs.push("ran");
          },
        }),
      );
    });

    const errors = (await Promise.all(replies)).map((reply) => reply.error);

    expect(errors).toMatchObject([{ cause: "end" }, { cause: "end" }]);

    expect(runs).toEqual([]);

    expect(fakes.map((fake) => fake.screen.lines())).toEqual([[], []]);
  });
});
