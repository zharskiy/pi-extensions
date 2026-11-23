import { describe, expect, it } from "vitest";
import { getPath, setPath, withoutPath } from "../../config/index.ts";

describe("dotted paths", () => {
  it("reads own keys only", () => {
    const value = JSON.parse('{"vm":{"cpus":4},"__proto__":{"polluted":true}}');

    expect(getPath(value, "vm.cpus")).toBe(4);
    expect(getPath(value, "vm.memoryGiB")).toBeUndefined();
    expect(getPath(value, "vm.cpus.more")).toBeUndefined();
    expect(getPath({ vm: {} }, "vm.constructor")).toBeUndefined();
    expect(getPath({}, "toString")).toBeUndefined();
  });

  it("sets a key, replacing a parent that is not an object", () => {
    expect(setPath({ vm: { cpus: 4 } }, "vm.diskGiB", 80)).toEqual({ vm: { cpus: 4, diskGiB: 80 } });
    expect(setPath({ vm: 3 }, "vm.cpus", 2)).toEqual({ vm: { cpus: 2 } });
  });

  it("removes a key and the parents it leaves empty, and keeps the object when nothing changes", () => {
    const value = { vm: { cpus: 4 }, writeBack: { enabled: true, exclude: {} } };

    expect(withoutPath(value, "vm.cpus")).toEqual({ writeBack: { enabled: true, exclude: {} } });
    expect(withoutPath(value, "writeBack.enabled")).toEqual({ vm: { cpus: 4 }, writeBack: { exclude: {} } });
    expect(withoutPath(value, "workspaceRoot")).toBe(value);
    expect(withoutPath(value, "vm.diskGiB")).toBe(value);
    expect(withoutPath({ vm: 3 }, "vm.cpus")).toEqual({ vm: 3 });
  });
});
