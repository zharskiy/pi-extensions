import {
  type AvailableModel,
  type KeyPress,
  type SkillInfo,
  THINKING_LEVELS,
} from "../../../../platform/pi-adapter/index.ts";
import { clampIndex, type MultiState, multiKey, tabStep } from "../../../../platform/ui-kit/index.ts";
import type { AgentKind } from "../../core/agent-setup/agent-template.ts";
import { SCOPES, type Scope, type SetupChange } from "../../core/agent-setup/scope.ts";
import { grantOrNone, sameGrant } from "../../core/model/agent-record.ts";
import {
  AGENT_SCOPE_ALL,
  type AgentOverride,
  ALL_SKILLS_TEXT,
  type Grant,
  INHERIT_MODEL,
} from "../../core/model/agent-schema.ts";
import { blockRows, listHeight } from "./setup-layout.ts";

type Draft = { model: string; thinking?: string; skills: Grant };

type SetupAgent = {
  name: string;
  role: AgentKind;
  description: string;
  tools: Grant;
  mcp: boolean;
  initial: Draft;
  proposed?: Draft;
  note?: string;
};

export type SetupContext = {
  agents: SetupAgent[];
  models: AvailableModel[];
  skills: SkillInfo[];
  trusted: boolean;
  project?: string;
};

const FIELDS = ["model", "thinking", "skills"] as const;

export type Field = (typeof FIELDS)[number];

export const FIELD_ROWS = FIELDS.length;

const PRESET_ORDER: readonly Field[] = ["skills", "model", "thinking"];

const CHORE_FIELDS = FIELDS.filter((field) => field !== "skills");

export const fieldsOf = (agent: SetupAgent | undefined): readonly Field[] =>
  agent?.role === "chore" ? CHORE_FIELDS : FIELDS;

export const presetFieldsOf = (agent: SetupAgent) =>
  PRESET_ORDER.filter((field) => fieldsOf(agent).includes(field));

export const fieldValue = (field: Field, draft: Draft) => {
  if (field === "model") {
    return draft.model;
  }

  return field === "thinking" ? (draft.thinking ?? "default") : grantOrNone(draft.skills);
};

export const PRESETS = ["previous", "suggested"] as const;

export type Preset = (typeof PRESETS)[number];

type Row = Field | Preset;

const isPreset = (row: Row | undefined): row is Preset => PRESETS.some((preset) => preset === row);

export const presetsOf = (agent: SetupAgent): { preset: Preset; draft: Draft }[] => [
  { preset: "previous", draft: agent.initial },
  ...(agent.role === "lead" && agent.proposed
    ? [{ preset: "suggested" as const, draft: agent.proposed }]
    : []),
];

const presetDraft = (agent: SetupAgent | undefined, preset: Preset) =>
  agent && presetsOf(agent).find((entry) => entry.preset === preset)?.draft;

const rowsOf = (agent: SetupAgent | undefined): readonly Row[] => [
  ...fieldsOf(agent),
  ...(agent ? presetsOf(agent).map((entry) => entry.preset) : []),
];

const ALL_ROW = -1;

type SkillsPicker = {
  field: "skills";
  order: number[];
  checked: boolean[];
  all: boolean;
  cursor: number;
  query: string;
};

type ListPicker = { field: "model" | "thinking"; cursor: number; query: string };

export type Picker = ListPicker | SkillsPicker;

export type SetupState = {
  drafts: Draft[];
  tab: number;
  field: number;
  picker?: Picker;
  scope: number;
};

type SetupOutcome = { state: SetupState; done?: "save" | "cancel" };

export const BLOCK_ROWS = blockRows(FIELD_ROWS, PRESETS.length);

export const scopeOptions = (context: SetupContext): readonly Scope[] =>
  context.trusted ? SCOPES : ["user"];

export const initialSetup = (context: SetupContext): SetupState => ({
  drafts: context.agents.map((agent) => agent.proposed ?? agent.initial),
  tab: 0,
  field: 0,
  scope: 0,
});

export const onSubmitTab = (context: SetupContext, state: SetupState) => state.tab === context.agents.length;

const sameField = (field: Field, left: Draft, right: Draft) =>
  field === "skills" ? sameGrant(left.skills, right.skills) : left[field] === right[field];

const changedFields = (agent: SetupAgent, draft: Draft, base: Draft = agent.initial) =>
  fieldsOf(agent).filter((field) => !sameField(field, base, draft));

export const fieldChanged = (context: SetupContext, state: SetupState, field: Field) => {
  const agent = context.agents[state.tab];
  const draft = state.drafts[state.tab];

  return Boolean(agent && draft && changedFields(agent, draft).includes(field));
};

export const presetInUse = (context: SetupContext, state: SetupState, preset: Preset) => {
  const agent = context.agents[state.tab];
  const draft = state.drafts[state.tab];
  const base = presetDraft(agent, preset);

  return Boolean(agent && draft && base && changedFields(agent, draft, base).length === 0);
};

export const setupChanges = (context: SetupContext, state: SetupState): SetupChange[] =>
  context.agents.flatMap((agent, index) => {
    const draft = state.drafts[index] ?? agent.initial;
    const fields = changedFields(agent, draft);

    if (fields.length === 0) {
      return [];
    }

    const patch = Object.fromEntries(fields.map((field) => [field, draft[field]])) as AgentOverride;

    return [{ name: agent.name, patch }];
  });

export const selectedRow = (context: SetupContext, state: SetupState): Row | undefined =>
  state.picker || onSubmitTab(context, state) ? undefined : rowsOf(context.agents[state.tab])[state.field];

export const changeRows = (context: SetupContext, state: SetupState) =>
  context.agents.flatMap((agent, index) => {
    const draft = state.drafts[index] ?? agent.initial;
    const proposed = agent.proposed;

    return changedFields(agent, draft).map((field) => ({
      name: agent.name,
      field,
      value: fieldValue(field, draft),
      was: fieldValue(field, agent.initial),
      suggested: Boolean(proposed && sameField(field, proposed, draft)),
    }));
  });

const modelOptions = (context: SetupContext, tab: number) => {
  const current = context.agents[tab]?.initial.model;
  const refs = context.models.map((model) => model.ref);
  const extra = current && current !== INHERIT_MODEL && !refs.includes(current) ? [current] : [];

  return [INHERIT_MODEL, ...extra, ...refs];
};

const thinkingOptions = (context: SetupContext, draft: Draft | undefined) =>
  context.models.find((model) => model.ref === draft?.model)?.thinking ?? [...THINKING_LEVELS];

const pickerOptions = (context: SetupContext, state: SetupState, field: "model" | "thinking") =>
  field === "model" ? modelOptions(context, state.tab) : thinkingOptions(context, state.drafts[state.tab]);

const matching = (labels: readonly string[], query: string) => {
  const needle = query.toLowerCase();

  return labels.flatMap((label, index) => (label.toLowerCase().includes(needle) ? [index] : []));
};

const queryKey = (key: KeyPress, query: string) => {
  if (key.name === "other" && key.char !== undefined && /^\P{Cc}$/u.test(key.char)) {
    return `${query}${key.char}`;
  }

  return key.name === "backspace" && query ? query.slice(0, -1) : undefined;
};

export const listView = (context: SetupContext, state: SetupState, picker: ListPicker) => {
  const options = pickerOptions(context, state, picker.field);

  return {
    shown: matching(options, picker.query).flatMap((index) => options[index] ?? []),
    total: options.length,
  };
};

const pickerSkills = (context: SetupContext, picker: SkillsPicker) =>
  picker.order.flatMap((index) => context.skills[index] ?? []);

const skillsPicker = (context: SetupContext, skills: Grant): SkillsPicker => {
  const named = skills === AGENT_SCOPE_ALL ? [] : skills;
  const listed = named.flatMap((name) => {
    const index = context.skills.findIndex((skill) => skill.name === name);

    return index < 0 ? [] : [index];
  });
  const order = [...new Set([...listed, ...context.skills.keys()])];
  const checked = order.map((index) => named.includes(context.skills[index]?.name ?? ""));

  return { field: "skills", order, checked, all: skills === AGENT_SCOPE_ALL, cursor: 0, query: "" };
};

export const skillsView = (context: SetupContext, picker: SkillsPicker) => {
  const skills = pickerSkills(context, picker);
  const names = skills.map((skill) => skill.name);
  const rows =
    picker.query || names.length === 0 ? matching(names, picker.query) : [ALL_ROW, ...picker.order.keys()];
  const options = rows.map((row) =>
    row === ALL_ROW
      ? { label: AGENT_SCOPE_ALL, description: ALL_SKILLS_TEXT }
      : { label: skills[row]?.name ?? "", description: skills[row]?.description },
  );
  const checked = rows.map((row) => (row === ALL_ROW ? picker.all : picker.checked[row] === true));
  const detail = rows[picker.cursor] === ALL_ROW ? undefined : options[picker.cursor]?.description;

  return { rows, options, multi: { cursor: picker.cursor, checked }, total: names.length, detail };
};

const ticked = (picker: SkillsPicker, rows: number[], multi: MultiState): SkillsPicker => {
  const at = (row: number) => multi.checked[rows.indexOf(row)];
  const checked = picker.checked.map((value, position) => at(position) ?? value);
  const all = at(ALL_ROW) ?? picker.all;

  if (all && !picker.all) {
    return { ...picker, all, checked: checked.map(() => false), cursor: multi.cursor };
  }

  return { ...picker, all: all && !checked.some(Boolean), checked, cursor: multi.cursor };
};

const openPicker = (context: SetupContext, state: SetupState): SetupState => {
  const field = fieldsOf(context.agents[state.tab])[state.field] ?? "model";
  const draft = state.drafts[state.tab];

  if (field === "skills") {
    return { ...state, picker: skillsPicker(context, draft?.skills ?? []) };
  }

  const options = pickerOptions(context, state, field);
  const value = field === "model" ? draft?.model : draft?.thinking;

  return { ...state, picker: { field, cursor: Math.max(0, options.indexOf(value ?? "")), query: "" } };
};

const setDraft = (state: SetupState, patch: Partial<Draft>): SetupState => ({
  ...state,
  picker: undefined,
  drafts: state.drafts.map((draft, index) => (index === state.tab ? { ...draft, ...patch } : draft)),
});

const modelPatch = (context: SetupContext, state: SetupState, model: string): Partial<Draft> => {
  const thinking = state.drafts[state.tab]?.thinking;
  const accepted =
    thinking === undefined || thinkingOptions(context, { model, skills: [] }).includes(thinking);

  return accepted ? { model } : { model, thinking: undefined };
};

const STEPS: Partial<Record<KeyPress["name"], (cursor: number, count: number, page: number) => number>> = {
  up: (cursor) => cursor - 1,
  down: (cursor) => cursor + 1,
  pageUp: (cursor, _, page) => cursor - page,
  pageDown: (cursor, _, page) => cursor + page,
  home: () => 0,
  end: (_, count) => count - 1,
};

const listStep = (key: KeyPress, cursor: number, count: number, page = count) => {
  const step = STEPS[key.name];

  return step ? clampIndex(step(cursor, count, page), count) : undefined;
};

const chooseFromList = (
  context: SetupContext,
  state: SetupState,
  picker: ListPicker,
  key: KeyPress,
): SetupState => {
  const { shown } = listView(context, state, picker);

  if (key.name === "enter") {
    const value = shown[picker.cursor];

    if (value === undefined) {
      return state;
    }

    return setDraft(
      state,
      picker.field === "model" ? modelPatch(context, state, value) : { thinking: value },
    );
  }

  const cursor = listStep(key, picker.cursor, shown.length, listHeight(BLOCK_ROWS, picker.field));

  return cursor === undefined ? state : { ...state, picker: { ...picker, cursor } };
};

const chooseSkills = (
  context: SetupContext,
  state: SetupState,
  picker: SkillsPicker,
  key: KeyPress,
): SetupState => {
  if (key.name !== "enter") {
    const view = skillsView(context, picker);
    const multi = multiKey(key, view.multi);

    return multi ? { ...state, picker: ticked(picker, view.rows, multi) } : state;
  }

  if (context.skills.length === 0) {
    return { ...state, picker: undefined };
  }

  const names = pickerSkills(context, picker)
    .filter((_, position) => picker.checked[position])
    .map((skill) => skill.name);

  return setDraft(state, { skills: picker.all ? AGENT_SCOPE_ALL : names });
};

const pickerKey = (context: SetupContext, state: SetupState, picker: Picker, key: KeyPress): SetupState => {
  const query = queryKey(key, picker.query);

  if (query !== undefined) {
    return { ...state, picker: { ...picker, query, cursor: 0 } };
  }

  if (key.name === "escape") {
    return { ...state, picker: picker.query ? { ...picker, query: "", cursor: 0 } : undefined };
  }

  return picker.field === "skills"
    ? chooseSkills(context, state, picker, key)
    : chooseFromList(context, state, picker, key);
};

const submitKey = (context: SetupContext, state: SetupState, key: KeyPress): SetupOutcome => {
  if (key.name === "enter") {
    return { state, done: "save" };
  }

  const scope = listStep(key, state.scope, scopeOptions(context).length);

  return { state: scope === undefined ? state : { ...state, scope } };
};

const applyPreset = (context: SetupContext, state: SetupState, preset: Preset): SetupState => {
  const draft = presetDraft(context.agents[state.tab], preset);

  return draft ? setDraft(state, { thinking: undefined, ...draft }) : state;
};

const agentKey = (context: SetupContext, state: SetupState, key: KeyPress): SetupState => {
  const rows = rowsOf(context.agents[state.tab]);
  const row = rows[state.field];

  if (key.name === "enter") {
    return isPreset(row) ? applyPreset(context, state, row) : openPicker(context, state);
  }

  const field = listStep(key, state.field, rows.length);

  return field === undefined ? state : { ...state, field };
};

export const pressSetupKey = (context: SetupContext, state: SetupState, key: KeyPress): SetupOutcome => {
  if (state.picker) {
    return { state: pickerKey(context, state, state.picker, key) };
  }

  if (key.name === "escape") {
    return { state, done: "cancel" };
  }

  const tab = tabStep(key, state.tab, context.agents.length + 1);

  if (tab !== undefined) {
    return { state: { ...state, tab, field: 0 } };
  }

  if (onSubmitTab(context, state)) {
    return submitKey(context, state, key);
  }

  return { state: agentKey(context, state, key) };
};
