import type { AgentRuntime, CodemodeShortfall } from "../../../../platform/pi-adapter/index.ts";
import {
  isPlainObject,
  type ObjectParse,
  readSettingsFile,
  readSettingsFiles,
  type SettingsLocation,
  type SettingsSchema,
  settingsPath,
} from "../../../../platform/shared/index.ts";
import {
  OVERRIDE_FIELDS,
  type OverrideField,
  overrideModel,
  overrideSkills,
  overrideThinking,
} from "./agent-override.ts";
import type { AgentOverride, AgentOverrides } from "./agent-schema.ts";

export type Settings = {
  maxConcurrent: number;
  maxDepth: number;
  softContextRatio: number;
  hardContextRatio: number;
  reserveTokens: number;
  inlineResultChars: number;
  failedLingerMs: number;
  doneLingerMs: number;
  renderThrottleMs: number;
  stopGraceSeconds: number;
  maxChainLength: number;
  disabledPlugins: string[];
  maxChildrenPerAgent: number;
  fetchTimeoutSeconds: number;
  fetchMaxBytes: number;
  fetchMaxChars: number;
  agents: AgentOverrides;
};

export const SETTINGS_FILE = "pi-subagents.json";

export const defaultSettings = (): Settings => ({
  maxConcurrent: 12,
  maxDepth: 3,
  softContextRatio: 0.8,
  hardContextRatio: 1.15,
  reserveTokens: 16_384,
  inlineResultChars: 8_000,
  failedLingerMs: 30_000,
  doneLingerMs: 10_000,
  renderThrottleMs: 250,
  stopGraceSeconds: 60,
  maxChainLength: 3,
  disabledPlugins: [],
  maxChildrenPerAgent: 6,
  fetchTimeoutSeconds: 20,
  fetchMaxBytes: 5_000_000,
  fetchMaxChars: 40_000,
  agents: {},
});

const range = (min: number, max: number) => ({ type: "number", min, max }) as const;

const OVERRIDE_PARSERS: Record<string, (value: unknown) => OverrideField> = {
  model: overrideModel,
  thinking: overrideThinking,
  skills: overrideSkills,
};

const parseOverride = (name: string, raw: unknown) => {
  if (!isPlainObject(raw)) {
    return { errors: [`${name} must be an object with ${OVERRIDE_FIELDS.join(", ")}`] };
  }

  const unknownKeys = Object.keys(raw).filter((key) => !(OVERRIDE_FIELDS as readonly string[]).includes(key));
  const errors = unknownKeys.map(
    (key) =>
      `${name}.${key} cannot be overridden (only ${OVERRIDE_FIELDS.join(", ")}); create an own agent instead`,
  );
  const fields = OVERRIDE_FIELDS.filter((key) => raw[key] !== undefined).map((key) =>
    OVERRIDE_PARSERS[key](raw[key]),
  );

  errors.push(...fields.flatMap((field) => (field.error ? [`${name}.${field.error}`] : [])));

  const override: AgentOverride = Object.assign({}, ...fields.map((field) => field.patch));

  return { override, errors };
};

const parseOverrides = (value: Record<string, unknown>): ObjectParse => {
  const parsed = Object.entries(value).map(([name, raw]) => ({ name, ...parseOverride(name, raw) }));
  const overrides: AgentOverrides = Object.fromEntries(
    parsed.flatMap(({ name, override }) => (override ? [[name, override]] : [])),
  );

  return { value: overrides, errors: parsed.flatMap((entry) => entry.errors) };
};

const mergeOverrides = (lower: AgentOverrides = {}, higher: AgentOverrides = {}): AgentOverrides =>
  Object.fromEntries(
    Array.from(new Set([...Object.keys(lower), ...Object.keys(higher)])).map((name) => [
      name,
      { ...lower[name], ...higher[name] },
    ]),
  );

const settingsSchema: SettingsSchema<Settings> = {
  maxConcurrent: range(1, 64),
  maxDepth: range(2, 4),
  softContextRatio: range(0.1, 1),
  hardContextRatio: range(1, 2),
  reserveTokens: range(0, 200_000),
  inlineResultChars: range(0, 1_000_000),
  failedLingerMs: range(0, 3_600_000),
  doneLingerMs: range(0, 3_600_000),
  renderThrottleMs: range(0, 10_000),
  stopGraceSeconds: range(0, 3_600),
  maxChainLength: range(1, 20),
  disabledPlugins: { type: "list", of: "plugin ids" },
  maxChildrenPerAgent: range(0, 50),
  fetchTimeoutSeconds: range(1, 300),
  fetchMaxBytes: range(10_000, 100_000_000),
  fetchMaxChars: range(1_000, 1_000_000),
  agents: { type: "object", of: "agent overrides", parse: parseOverrides },
};

export const settingsPaths = (info: { agentDir: string; cwd: string }) => ({
  project: settingsPath(info, "project", SETTINGS_FILE),
  user: settingsPath(info, "user", SETTINGS_FILE),
});

export const disabledPlugins = (agentDir: string) =>
  readSettingsFile(settingsSchema, settingsPath({ agentDir, cwd: "" }, "user", SETTINGS_FILE)).patch
    .disabledPlugins ?? [];

export const loadSettings = (location: SettingsLocation) => {
  const { user, project, errors } = readSettingsFiles(settingsSchema, SETTINGS_FILE, location);
  const { disabledPlugins: ignored, ...projectPatch } = project;

  if (ignored !== undefined) {
    errors.push(
      `${settingsPath(location, "project", SETTINGS_FILE)}: disabledPlugins is read from the user settings file only`,
    );
  }

  const agents = mergeOverrides(user.agents, projectPatch.agents);

  return { settings: { ...defaultSettings(), ...user, ...projectPatch, agents }, errors };
};

const shortfallMessage = ({ setting, workers, wanted }: CodemodeShortfall) =>
  `${setting}=${workers} is below the ${wanted} codemode workers the agents may need; agents' codemode scripts may wait or fail`;

export const reloadSettings = (
  settings: Settings,
  location: SettingsLocation,
  runtime: Pick<AgentRuntime, "reserveCodemodeWorkers">,
  report: (errors: readonly string[]) => void,
) => {
  const loaded = loadSettings(location);

  Object.assign(settings, loaded.settings);

  const shortfall = runtime.reserveCodemodeWorkers(settings.maxConcurrent);

  report(shortfall ? [...loaded.errors, shortfallMessage(shortfall)] : loaded.errors);
};
