import { describe, expect, it } from "vitest";
import { type ContainerState, LABELS, type VmInspect } from "../../backend/index.ts";
import { runPinata } from "../../cli/index.ts";
import { sha256Hex, stateLayout } from "../../shared/index.ts";
import { createFakeBackend, createHarness } from "./harness.ts";

const SIZE = { cpus: 4, memoryGiB: 8, diskGiB: 60 };

type Fake = ReturnType<typeof createFakeBackend>;

const listed = async (state: VmInspect | Error, setup?: (fake: Fake, hash: string) => void) => {
  const fake = createFakeBackend({
    vm: { inspect: async () => (state instanceof Error ? Promise.reject(state) : state) },
  });
  const harness = await createHarness({ backend: () => fake.backend });

  setup?.(fake, sha256Hex(harness.repoRoot));

  await harness.writeJson(stateLayout(harness.stateDir).repo(sha256Hex(harness.repoRoot)).record, {
    root: harness.repoRoot,
  });

  expect(await runPinata(["list"], harness.deps)).toBe(0);

  return { stdout: harness.stdout(), harness };
};

describe("pinata list", () => {
  it("says when the VM is not created", async () => {
    expect((await listed({ state: "absent" })).stdout).toBe("The sandbox VM is not created yet.\n");
  });

  it.each<[VmInspect | Error, string]>([
    [
      { state: "stopped", size: SIZE, shares: [] },
      "The sandbox VM is stopped with 4 CPUs and 8 GiB of memory.\n",
    ],
    [new Error("colima did not answer within 3 seconds"), "The sandbox VM is stopped.\n"],
  ])("gives the size of a stopped VM when colima has it", async (state, line) => {
    expect((await listed(state)).stdout).toBe(line);
  });

  it("lists the sessions of every repository in a running VM", async () => {
    const ids: string[] = [];
    const { stdout, harness } = await listed({ state: "running", size: SIZE, shares: [] }, (fake, hash) => {
      const session = (repoHash: string, state: ContainerState) =>
        fake.addContainer({
          name: state,
          labels: { [LABELS.managed]: "true", [LABELS.role]: "agent", [LABELS.repoHash]: repoHash },
          state,
          image: "x",
        });

      ids.push(session(hash, "running"), session("gone", "stopped"));

      fake.addContainer({ name: "proxy", labels: { [LABELS.role]: "proxy" }, state: "running", image: "x" });
    });

    expect(stdout).toBe(
      [
        "The sandbox VM is running with 4 CPUs and 8 GiB of memory.",
        `  Sessions:  ${harness.repoRoot} (${ids[0]?.slice(0, 12)}, running)`,
        `             a folder pinata no longer knows (${ids[1]?.slice(0, 12)}, stopped)`,
        "",
      ].join("\n"),
    );
    expect(harness.calls).toEqual([]);
  });

  it("says when a running VM runs no session", async () => {
    expect((await listed({ state: "running", size: SIZE, shares: [] })).stdout).toBe(
      ["The sandbox VM is running with 4 CPUs and 8 GiB of memory.", "  Sessions:  none", ""].join("\n"),
    );
  });
});
