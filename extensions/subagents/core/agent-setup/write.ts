import { errorText, isPlainObject, readText, writeSettingsFile } from "../../../../platform/shared/index.ts";
import { SETTINGS_FILE, settingsPaths } from "../model/settings.ts";
import type { Scope, SetupChange } from "./scope.ts";

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

export const writeChanges = (
  location: { agentDir: string; cwd: string },
  scope: Scope,
  changes: SetupChange[],
): string | undefined => {
  const path = settingsPaths(location)[scope];

  try {
    const next = mergeChanges(readObject(path), changes);

    writeSettingsFile(location, scope, SETTINGS_FILE, `${JSON.stringify(next, null, 2)}\n`);

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
