import { mkdirSync, writeFileSync } from "node:fs";
import {
  errorText,
  readSettingsFiles,
  type SettingsLocation,
  type SettingsSchema,
  userSettingsPath,
} from "../../../shared/index.ts";

type StyleSettings = { style: string };

export const SETTINGS_FILE = "pi-style.json";

const styleSchema = (names: readonly string[]): SettingsSchema<StyleSettings> => ({
  style: { type: "choice", values: names },
});

export const readStyleSettings = (names: readonly string[], location: SettingsLocation) => {
  const { user, project, errors } = readSettingsFiles(styleSchema(names), SETTINGS_FILE, location);

  return { user: user.style, project: project.style, errors };
};

export const saveStyle = (agentDir: string, style: string): string | undefined => {
  const path = userSettingsPath(agentDir, SETTINGS_FILE);

  try {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(path, `${JSON.stringify({ style }, null, 2)}\n`);
    return undefined;
  } catch (error) {
    return `cannot save ${path}: ${errorText(error)}`;
  }
};
