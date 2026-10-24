import { afterEach, describe, expect, it } from "vitest";
import { CODEMODE_WORKERS_SETTING, reserveCodemodeWorkers } from "../../../pi-adapter/child/pi-codemode.ts";

type CodemodeModule = typeof import("../../../pi-adapter/child/pi-codemode.ts");

const loadCopy = async (tag: string): Promise<CodemodeModule> =>
  import(new URL(`../../../pi-adapter/child/pi-codemode.ts?copy=${tag}`, import.meta.url).href);

const original = process.env[CODEMODE_WORKERS_SETTING];

const setWorkers = (value: string | undefined) => {
  if (value === undefined) {
    delete process.env[CODEMODE_WORKERS_SETTING];
  } else {
    process.env[CODEMODE_WORKERS_SETTING] = value;
  }
};

const current = () => process.env[CODEMODE_WORKERS_SETTING];

describe("codemode workers", () => {
  afterEach(() => {
    setWorkers(original);
  });

  it("sets the agent sessions plus the spare workers when nothing is set", () => {
    setWorkers(undefined);

    expect(reserveCodemodeWorkers(10)).toBeUndefined();
    expect(current()).toBe("12");
  });

  it("keeps an explicit value that covers the wanted count", () => {
    setWorkers("32");

    expect(reserveCodemodeWorkers(11)).toBeUndefined();
    expect(current()).toBe("32");
  });

  it("keeps an explicit value below the wanted count and reports the shortfall with the setting name", () => {
    setWorkers("4");

    expect(reserveCodemodeWorkers(12)).toEqual({
      setting: "PI_CODEMODE_MAX_WORKERS",
      workers: 4,
      wanted: 14,
    });
    expect(current()).toBe("4");
  });

  it("treats its own earlier value as unset and applies the new count", () => {
    setWorkers(undefined);
    reserveCodemodeWorkers(13);

    expect(reserveCodemodeWorkers(20)).toBeUndefined();
    expect(current()).toBe("22");
    expect(reserveCodemodeWorkers(4)).toBeUndefined();
    expect(current()).toBe("6");
  });

  it("treats a value other in-process code wrote over its own as explicit", () => {
    setWorkers(undefined);
    reserveCodemodeWorkers(15);
    setWorkers("3");

    expect(reserveCodemodeWorkers(16)).toEqual({
      setting: "PI_CODEMODE_MAX_WORKERS",
      workers: 3,
      wanted: 18,
    });
    expect(current()).toBe("3");
  });

  it.each([
    ["", 21],
    ["zero", 22],
    ["0", 23],
    ["-3", 24],
    ["2.5", 25],
  ])("treats %j as unset", (value, agentSessions) => {
    setWorkers(value);

    expect(reserveCodemodeWorkers(agentSessions)).toBeUndefined();
    expect(current()).toBe(String(agentSessions + 2));
  });

  it("recognises its own value across separately loaded copies of the module", async () => {
    const copy = await loadCopy("second");

    setWorkers(undefined);
    reserveCodemodeWorkers(30);

    expect(copy.reserveCodemodeWorkers(31)).toBeUndefined();
    expect(current()).toBe("33");
  });
});
