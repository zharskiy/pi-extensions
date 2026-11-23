import { describe, expect, it } from "vitest";
import type { VmPhase } from "../../backend/index.ts";
import { warningOf } from "../../cli/prompt/task.ts";
import { Cancelled, type Detail, type Prompts } from "../../cli/prompt/types.ts";
import { applyPlan, lineFrontEnd, wizardFrontEnd } from "../../cli/setup/apply.ts";
import type { Plan } from "../../cli/setup/types.ts";
import { LauncherError } from "../../shared/index.ts";
import { fakeTimers } from "./prompt/fake-tty.ts";
import { AUTOMATIC_SIZE, documentOf, factsOf } from "./setup-fixtures.ts";

const PLAN: Plan = {
  next: {},
  text: "",
  changes: [],
  reindented: false,
  vm: { kind: "restart", size: AUTOMATIC_SIZE, shares: [], parts: ["size"] },
  problems: [],
};

const interrupted = async (phases: VmPhase[]) => {
  const notes: string[] = [];
  const warnings: string[] = [];
  const prompts = {
    task: async (spec: Parameters<Prompts["task"]>[0]) => {
      await spec.run(() => undefined);

      warnings.push(warningOf(spec));

      throw new Cancelled("interrupt");
    },
    note: (lines: Detail) => {
      notes.push((typeof lines === "function" ? lines(76) : lines).join(" "));
    },
  } as unknown as Prompts;
  const document = documentOf(undefined, "/Users/me/config.json");
  const facts = factsOf();
  const effects = {
    write: async () => undefined,
    vm: async (_action: unknown, progress: (phase: VmPhase) => void) => {
      phases.forEach(progress);

      return "restarted" as const;
    },
  };
  const io = { prompts, plain: true, now: () => 0 };
  const code = await applyPlan(wizardFrontEnd(io, facts), effects, document, {
    plan: PLAN,
    answers: { root: "~/work", vm: "automatic", writeBack: true },
  });

  return { code, said: notes.join("\n"), warned: warnings.join("\n") };
};

describe("stopping waiting for the VM step", () => {
  it("says the VM may be stopped when the wait ends while it stops", async () => {
    const { code, said, warned } = await interrupted(["stopping"]);

    expect(code).toBe(130);
    expect(warned).toBe(
      "The VM is still stopping. Press ctrl-c again to stop waiting; your settings are already saved.",
    );
    expect(said).toContain(
      "Stopped waiting. Your settings are saved; the VM may be stopped now, and the next pi starts it.",
    );
  });

  it("says the VM may still be starting once the start began", async () => {
    const { said, warned } = await interrupted(["stopping", "starting"]);

    expect(warned).toContain("The VM is still starting.");
    expect(said).toContain("Stopped waiting. Your settings are saved; the VM may still be starting.");
  });

  it("says the VM may still be being created during a create", async () => {
    const { said, warned } = await interrupted(["creating"]);

    expect(warned).toContain("The VM is still being created.");
    expect(said).toContain("Stopped waiting. Your settings are saved; the VM may still be being created.");
  });
});

const collected = () => {
  const lines: string[] = [];
  const stream = { write: (text: string) => lines.push(text) } as unknown as NodeJS.WritableStream;

  return { stream, text: () => lines.join("") };
};

describe("applying a plan as lines", () => {
  it("prints the review, progress and the heartbeat to stdout, and a failure to stderr", async () => {
    const clock = fakeTimers();
    const out = collected();
    const err = collected();
    const document = documentOf(undefined, "/Users/me/config.json");
    const facts = factsOf({ configFile: "/Users/me/config.json" });
    const effects = {
      write: async () => undefined,
      vm: async (_action: unknown, progress: (phase: VmPhase) => void) => {
        progress("stopping");

        clock.advance(31_000);

        progress("starting");

        throw new LauncherError("colima start failed");
      },
    };
    const front = lineFrontEnd({ out: out.stream, err: err.stream, timers: clock.timers }, facts, [
      "When you apply:",
      "  • restart the sandbox VM",
    ]);
    const code = await applyPlan(front, effects, document, {
      plan: PLAN,
      answers: { root: "~/work", vm: "automatic", writeBack: true },
    });

    expect(code).toBe(1);
    expect(out.text()).toBe(
      [
        "When you apply:",
        "  - restart the sandbox VM",
        "Stopping the VM...",
        "  still working (15s)",
        "  still working (30s)",
        "Starting the VM with the new size...",
        "",
      ].join("\n"),
    );
    expect(err.text()).toBe(
      [
        "x Could not restart the VM after 31s.",
        "  colima start failed",
        "Your settings are saved, but the sandbox VM is not ready. Fix the problem above, then run pi sandbox init again. pi sandbox doctor checks everything.",
        "",
      ].join("\n"),
    );
    expect(clock.live()).toBe(0);
  });

  it("lets an unexpected error from the VM step through, after saving", async () => {
    const clock = fakeTimers();
    const out = collected();
    const err = collected();
    const failure = new Error("EACCES: permission denied, mkdir");
    const effects = {
      write: async () => undefined,
      vm: async () => {
        throw failure;
      },
    };
    const front = lineFrontEnd({ out: out.stream, err: err.stream, timers: clock.timers }, factsOf(), []);
    const applied = applyPlan(front, effects, documentOf(undefined, "/Users/me/config.json"), {
      plan: PLAN,
      answers: { root: "~/work", vm: "automatic", writeBack: true },
    });

    await expect(applied).rejects.toBe(failure);
    expect(err.text()).toBe("");
    expect(clock.live()).toBe(0);
  });
});
