import { splitModelRequest, THINKING_LEVELS } from "../../../../core/adapter/contract.ts";
import {
  isPlainObject,
  type ObjectParse,
  projectSettingsPath,
  readSettingsFile,
  type SettingsParse,
  type SettingsSchema,
  userSettingsPath,
} from "../../../../core/manager/settings.ts";
import { type AgentOverride, type AgentOverrides, ALL } from "./agent-schema.ts";

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

const SETTINGS_FILE = "pi-subagents.json";

export const defaultSettings = (): Settings => ({
  maxConcurrent: 4,
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

const OVERRIDE_FIELDS = ["model", "thinking", "skills"];

type FieldParse = { patch: AgentOverride; error?: string };

const overrideModel = (value: unknown): FieldParse => {
  if (typeof value !== "string" || value.trim().length === 0 || /\s/.test(value.trim())) {
    return { patch: {}, error: "model must be provider/id[:thinking] without spaces" };
  }

  const request = splitModelRequest(value);

  if (request.error) {
    return { patch: {}, error: `model: ${request.error}` };
  }

  const thinking = request.thinking ? { thinking: request.thinking } : {};

  return request.name.length === 0 ? { patch: thinking } : { patch: { model: request.name, ...thinking } };
};

const overrideThinking = (value: unknown): FieldParse =>
  typeof value === "string" && THINKING_LEVELS.includes(value)
    ? { patch: { thinking: value } }
    : { patch: {}, error: `thinking must be one of ${THINKING_LEVELS.join(", ")}` };

const overrideSkills = (value: unknown): FieldParse => {
  if (value === ALL) {
    return { patch: { skills: ALL } };
  }

  if (Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.trim().length > 0)) {
    return { patch: { skills: Array.from(new Set(value.map((entry: string) => entry.trim()))) } };
  }

  return { patch: {}, error: `skills must be "${ALL}" or a list of skill names` };
};

const OVERRIDE_PARSERS: Record<string, (value: unknown) => FieldParse> = {
  model: overrideModel,
  thinking: overrideThinking,
  skills: overrideSkills,
};

const parseOverride = (name: string, raw: unknown) => {
  if (!isPlainObject(raw)) {
    return { errors: [`${name} must be an object with ${OVERRIDE_FIELDS.join(", ")}`] };
  }

  const unknown = Object.keys(raw).filter((key) => !OVERRIDE_FIELDS.includes(key));
  const errors = unknown.map(
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

export const mergeOverrides = (lower: AgentOverrides = {}, higher: AgentOverrides = {}): AgentOverrides =>
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

const readUser = (agentDir: string) =>
  readSettingsFile(settingsSchema, userSettingsPath(agentDir, SETTINGS_FILE));

export const disabledPlugins = (agentDir: string) => readUser(agentDir).patch.disabledPlugins ?? [];

export const loadSettings = (agentDir: string, cwd: string, projectTrusted: boolean) => {
  const projectPath = projectSettingsPath(cwd, SETTINGS_FILE);
  const user = readUser(agentDir);
  const project: SettingsParse<Settings> = projectTrusted
    ? readSettingsFile(settingsSchema, projectPath)
    : { patch: {}, errors: [] };
  const { disabledPlugins: ignored, ...projectPatch } = project.patch;
  const errors = [...user.errors, ...project.errors];

  if (ignored !== undefined) {
    errors.push(`${projectPath}: disabledPlugins is read from the user settings file only`);
  }

  const agents = mergeOverrides(user.patch.agents, projectPatch.agents);

  return { settings: { ...defaultSettings(), ...user.patch, ...projectPatch, agents }, errors };
};
