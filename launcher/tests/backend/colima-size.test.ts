import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createColimaVm, recommendedVmSize } from "../../backend/colima/vm.ts";
import { launcherRoot } from "../../shared/index.ts";
import { createFakeRunner, type FakeResponder } from "../support/fake-runner.ts";

const GIB = 1024 ** 3;

const SAMPLES: Array<[number, number]> = [
  [1, 2],
  [2, 7],
  [4, 8],
  [8, 16],
  [10, 18],
  [12, 24],
  [16, 64],
];

const installText = () => readFileSync(join(launcherRoot(), "install.sh"), "utf8");

const functionOf = (text: string, name: string) => {
  const start = text.indexOf(`\n${name}() {\n`);
  const end = text.indexOf("\n}\n", start);

  return text.slice(start + 1, end + 2);
};

const settingOf = (text: string, name: string) =>
  text.split("\n").find((line) => line.startsWith(`${name}=`)) ?? "";

const installSize = (cpus: number, memGiB: number) => {
  const text = installText();
  const script = [
    settingOf(text, "max_cpus"),
    settingOf(text, "max_memory"),
    'cpus=""',
    'memory=""',
    'sizing=""',
    `sysctl() { case "$2" in hw.ncpu) echo ${cpus} ;; hw.memsize) echo ${memGiB * GIB} ;; esac; }`,
    functionOf(text, "clamp"),
    functionOf(text, "size_to_host"),
    "size_to_host",
    'echo "$cpus $memory"',
  ].join("\n");
  const [shownCpus, shownMemory] = spawnSync("sh", ["-c", script], { encoding: "utf8" })
    .stdout.trim()
    .split(" ");

  return { cpus: Number(shownCpus), memoryGiB: Number(shownMemory) };
};

const vmWith = (respond: FakeResponder) =>
  createColimaVm({
    home: "/nonexistent",
    stateDir: "/nonexistent",
    runner: createFakeRunner(respond).runner,
    detect: async () => ({ available: true }),
  });

describe("the sandbox VM size", () => {
  it("recommends the size install.sh gives a Mac of the same size", () => {
    SAMPLES.forEach(([cpus, memGiB]) => {
      expect(recommendedVmSize(cpus, memGiB)).toEqual(installSize(cpus, memGiB));
    });
  });

  it("names the colima commands that resize the profile", () => {
    expect(vmWith(() => undefined).resizeCommand({ cpus: 6, memoryGiB: 8 })).toBe(
      "colima stop --profile pi-sandbox && colima start --profile pi-sandbox --activate=false --cpu 6 --memory 8",
    );
  });

  it("reads the size colima reports for the profile", async () => {
    const vm = vmWith((call) =>
      call.args.join(" ") === "status --profile pi-sandbox --json"
        ? { stdout: JSON.stringify({ cpu: 4, memory: 6 * GIB }) }
        : undefined,
    );

    expect(await vm.size()).toEqual({ cpus: 4, memoryGiB: 6 });
  });

  it("knows no size when colima is missing or reports none", async () => {
    const missing = vmWith(() => undefined);
    const stopped = vmWith(() => ({ code: 1, stderr: "not running" }));

    expect(await missing.size()).toBeUndefined();
    expect(await stopped.size()).toBeUndefined();
  });
});
