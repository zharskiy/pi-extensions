import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isPlainObject } from "../../../../../core/manager/guards.ts";
import { readText } from "../../../../../core/manager/settings.ts";
import { errorText } from "../../components/format.ts";
import type { SetupChange } from "./form.ts";

const readObject = (path: string): Record<string, unknown> => {
  const text = readText(path) ?? "";
  const parsed: unknown = text.trim() ? JSON.parse(text) : {};

  if (!isPlainObject(parsed)) {
    throw new Error("the file is not a JSON object; fix it by hand first");
  }

  return parsed;
};

export const mergeChanges = (current: Record<string, unknown>, changes: SetupChange[]) => {
  const agents = current.agents ?? {};

  if (!isPlainObject(agents)) {
    throw new Error('"agents" is not an object; fix it by hand first');
  }

  const merged: Record<string, unknown> = { ...agents };

  changes.forEach(({ name, patch }) => {
    const existing = merged[name];

    merged[name] = { ...(isPlainObject(existing) ? existing : {}), ...patch };
  });

  return { ...current, agents: merged };
};

export const writeChanges = (path: string, changes: SetupChange[]): string | undefined => {
  try {
    const next = mergeChanges(readObject(path), changes);

    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);

    return undefined;
  } catch (error) {
    return `cannot save ${path}: ${errorText(error)}`;
  }
};

export const overriddenFields = (path: string, changes: SetupChange[]) => {
  try {
    const agents = readObject(path).agents;

    if (!isPlainObject(agents)) {
      return [];
    }

    return changes.flatMap(({ name, patch }) => {
      const set = agents[name];

      return isPlainObject(set)
        ? Object.keys(patch)
            .filter((field) => set[field] !== undefined)
            .map((field) => `agents.${name}.${field}`)
        : [];
    });
  } catch {
    return [];
  }
};
