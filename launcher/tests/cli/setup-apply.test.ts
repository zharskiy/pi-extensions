import { describe, expect, it } from "vitest";
import type { VmPhase } from "../../backend/index.ts";
import { Cancelled, type Detail, type Prompts, warningOf } from "../../cli/prompt/types.ts";
import { applyPlan } from "../../cli/setup/apply.ts";
import { readDocument } from "../../cli/setup/document.ts";
import type { HostFacts, Plan } from "../../cli/setup/types.ts";

const SIZE = { cpus: 8, memoryGiB: 10, diskGiB: 60 };

const PLAN: Plan = {
  next: {},
  text: "",
  changes: [],
  reindented: false,
  vm: { kind: "restart", size: SIZE, shares: [], exactShares: true, parts: ["size"] },
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
  const read = readDocument("/Users/me/config.json", undefined);
  const document = read.ok ? read.document : undefined;
  const facts = { home: "/Users/me" } as HostFacts;
  const effects = {
    write: async () => undefined,
    vm: async (_action: unknown, progress: (phase: VmPhase) => void) => {
      phases.forEach(progress);

      return "restarted" as const;
    },
  };
  const io = { prompts, plain: true, columns: () => 200, now: () => 0 };
  const code = await applyPlan(
    io,
    effects,
    { document: document as NonNullable<typeof document>, facts },
    {
      plan: PLAN,
      answers: { roots: "home", vm: "automatic", writeBack: true },
    },
  );

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
