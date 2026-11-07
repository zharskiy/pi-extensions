import { isIP } from "node:net";
import { isCompiled } from "../shared/index.ts";

export const TEST_RESOLVE_ENV = "PI_SANDBOX_TEST_RESOLVE";

type Entry = [string, string];

const entryOf = (pair: string): Entry | undefined => {
  const [name = "", address = ""] = pair.split("=").map((part) => part.trim());

  return name === "" || isIP(address) === 0 ? undefined : [name.toLowerCase(), address];
};

export const testResolveOverrides = (
  env: Record<string, string | undefined>,
  moduleUrl = import.meta.url,
): ReadonlyMap<string, string> => {
  const value = env[TEST_RESOLVE_ENV];

  if (value === undefined || value === "" || isCompiled(moduleUrl)) {
    return new Map();
  }

  const entries = value.split(",").map(entryOf);

  return new Map(entries.filter((entry): entry is Entry => entry !== undefined));
};
