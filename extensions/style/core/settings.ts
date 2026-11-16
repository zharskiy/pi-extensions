import {
  errorText,
  readSettingsFiles,
  type SettingsLocation,
  type SettingsSchema,
  settingsPath,
  writeSettingsFile,
} from "../../../platform/shared/index.ts";

type StyleSettings = { style: string };

export const NAMESPACE = "pi-style";

export const SETTINGS_FILE = `${NAMESPACE}.json`;

const styleSchema = (names: readonly string[]): SettingsSchema<StyleSettings> => ({
  style: { type: "choice", values: names },
});

export const readStyleSettings = (names: readonly string[], location: SettingsLocation) => {
  const { user, project, errors } = readSettingsFiles(styleSchema(names), SETTINGS_FILE, location);

  return { user: user.style, project: project.style, errors };
};

export const saveStyle = (location: SettingsLocation, style: string): string | undefined => {
  try {
    writeSettingsFile(location, "user", SETTINGS_FILE, `${JSON.stringify({ style }, null, 2)}\n`);
    return undefined;
  } catch (error) {
    return `cannot save ${settingsPath(location, "user", SETTINGS_FILE)}: ${errorText(error)}`;
  }
};
