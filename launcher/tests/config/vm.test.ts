import { describe, expect, it } from "vitest";
import { defaultConfig } from "../../config/defaults.ts";
import { validateConfig } from "../../config/validate.ts";
import { errorMessage } from "../../shared/index.ts";

const problemOf = (value: unknown) => {
  try {
    validateConfig(value);

    return undefined;
  } catch (error) {
    return errorMessage(error);
  }
};

describe("the vm key", () => {
  it("is empty by default, so the VM keeps the size install.sh gave it", () => {
    expect(defaultConfig().vm).toEqual({});
  });

  it("accepts whole numbers within bounds", () => {
    expect(problemOf({ vm: { cpus: 4, memoryGiB: 8, diskGiB: 80 } })).toBeUndefined();
    expect(problemOf({ vm: { cpus: 1, memoryGiB: 2, diskGiB: 20 } })).toBeUndefined();
    expect(problemOf({ vm: { cpus: 64, memoryGiB: 256, diskGiB: 2048 } })).toBeUndefined();
  });

  it.each([
    [{ cpus: 0 }, "vm.cpus must be at least 1"],
    [{ cpus: 65 }, "vm.cpus must be at most 64"],
    [{ cpus: 2.5 }, "vm.cpus must be a whole number"],
    [{ memoryGiB: 1 }, "vm.memoryGiB must be at least 2"],
    [{ memoryGiB: 257 }, "vm.memoryGiB must be at most 256"],
    [{ diskGiB: 10 }, "vm.diskGiB must be at least 20"],
    [{ diskGiB: 4096 }, "vm.diskGiB must be at most 2048"],
    [{ diskGiB: "80" }, "vm.diskGiB must be a number"],
    [{ disk: 80 }, "vm.disk is not a known key"],
  ])("refuses %j", (vm, message) => {
    expect(problemOf({ vm })).toBe(`config: ${message}`);
  });

  it("refuses a container limit above the VM it runs in", () => {
    expect(problemOf({ vm: { cpus: 4 }, resources: { cpus: 6 } })).toBe(
      "config: resources.cpus 6 is larger than vm.cpus 4; resources limits one container inside the VM",
    );
    expect(problemOf({ vm: { memoryGiB: 8 }, resources: { memoryGiB: 9 } })).toBe(
      "config: resources.memoryGiB 9 is larger than vm.memoryGiB 8; resources limits one container inside the VM",
    );
    expect(problemOf({ vm: { cpus: 4 }, resources: { cpus: 4, memoryGiB: 64 } })).toBeUndefined();
    expect(problemOf({ resources: { cpus: 64 } })).toBeUndefined();
  });
});
