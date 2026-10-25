import {
  type AvailableModel,
  type KeyPress,
  type SkillInfo,
  THINKING_LEVELS,
} from "../../../../platform/pi-adapter/index.ts";
import {
  checkedIndexes,
  clampIndex,
  initialMulti,
  type MultiState,
  multiKey,
  tabStep,
} from "../../../../platform/ui-kit/index.ts";
import { SCOPES, type Scope, type SetupChange } from "../../core/agent-setup/scope.ts";
import { sameGrant } from "../../core/model/agent-record.ts";
import {
  AGENT_SCOPE_ALL,
  type AgentOverride,
  type Grant,
  INHERIT_MODEL,
} from "../../core/model/agent-schema.ts";

type Draft = { model: string; thinking?: string; skills: Grant };

type SetupAgent = {
  name: string;
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

export const FIELDS = ["model", "thinking", "skills"] as const;

export type Field = (typeof FIELDS)[number];

type SkillsPicker = { field: "skills"; multi: MultiState; order: number[]; touched?: boolean };

export type Picker = { field: "model" | "thinking"; cursor: number } | SkillsPicker;

export type SetupState = {
  drafts: Draft[];
  tab: number;
  field: number;
  picker?: Picker;
  scope: number;
};

type SetupOutcome = { state: SetupState; done?: "save" | "cancel" };

export const LIST_HEIGHT = 8;

export const scopeOptions = (context: SetupContext): readonly Scope[] =>
  context.trusted ? SCOPES : ["user"];

export const initialSetup = (context: SetupContext): SetupState => ({
  drafts: context.agents.map((agent) => agent.proposed ?? agent.initial),
  tab: 0,
  field: 0,
  scope: 0,
});

export const onSubmitTab = (context: SetupContext, state: SetupState) => state.tab === context.agents.length;

const changedFields = (initial: Draft, draft: Draft): Field[] =>
  FIELDS.filter((field) =>
    field === "skills" ? !sameGrant(initial.skills, draft.skills) : initial[field] !== draft[field],
  );

export const fieldChanged = (context: SetupContext, state: SetupState, tab: number, field: Field) => {
  const agent = context.agents[tab];
  const draft = state.drafts[tab];

  return Boolean(agent && draft && changedFields(agent.initial, draft).includes(field));
};

export const setupChanges = (context: SetupContext, state: SetupState): SetupChange[] =>
  context.agents.flatMap((agent, index) => {
    const draft = state.drafts[index] ?? agent.initial;
    const fields = changedFields(agent.initial, draft);

    if (fields.length === 0) {
      return [];
    }

    const patch = Object.fromEntries(fields.map((field) => [field, draft[field]])) as AgentOverride;

    return [{ name: agent.name, patch }];
  });

export const modelOptions = (context: SetupContext, tab: number) => {
  const current = context.agents[tab]?.initial.model;
  const refs = context.models.map((model) => model.ref);
  const extra = current && current !== INHERIT_MODEL && !refs.includes(current) ? [current] : [];

  return [INHERIT_MODEL, ...extra, ...refs];
};

export const thinkingOptions = (context: SetupContext, draft: Draft | undefined) =>
  context.models.find((model) => model.ref === draft?.model)?.thinking ?? [...THINKING_LEVELS];

const pickerOptions = (context: SetupContext, state: SetupState, field: "model" | "thinking") =>
  field === "model" ? modelOptions(context, state.tab) : thinkingOptions(context, state.drafts[state.tab]);

export const pickerSkills = (context: SetupContext, picker: SkillsPicker) =>
  picker.order.flatMap((index) => context.skills[index] ?? []);

const skillsPicker = (context: SetupContext, named: readonly string[]): SkillsPicker => {
  const listed = named.flatMap((name) => {
    const index = context.skills.findIndex((skill) => skill.name === name);

    return index < 0 ? [] : [index];
  });
  const order = [...new Set([...listed, ...context.skills.keys()])];
  const checked = order.map((index) => named.includes(context.skills[index]?.name ?? ""));

  return { field: "skills", multi: initialMulti(order.length, checked), order };
};

const openPicker = (context: SetupContext, state: SetupState): SetupState => {
  const field = FIELDS[state.field] ?? "model";
  const draft = state.drafts[state.tab];

  if (field === "skills") {
    const named = draft?.skills === AGENT_SCOPE_ALL ? [] : (draft?.skills ?? []);

    return { ...state, picker: skillsPicker(context, named) };
  }

  const options = pickerOptions(context, state, field);
  const value = field === "model" ? draft?.model : draft?.thinking;

  return { ...state, picker: { field, cursor: Math.max(0, options.indexOf(value ?? "")) } };
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

const PAGE = LIST_HEIGHT;

const STEPS: Partial<Record<KeyPress["name"], (cursor: number, count: number) => number>> = {
  up: (cursor) => cursor - 1,
  down: (cursor) => cursor + 1,
  pageUp: (cursor) => cursor - PAGE,
  pageDown: (cursor) => cursor + PAGE,
  home: () => 0,
  end: (_, count) => count - 1,
};

const listStep = (key: KeyPress, cursor: number, count: number) => {
  const step = STEPS[key.name];

  return step ? clampIndex(step(cursor, count), count) : undefined;
};

const chooseFromList = (
  context: SetupContext,
  state: SetupState,
  picker: { field: "model" | "thinking"; cursor: number },
  key: KeyPress,
): SetupState => {
  const options = pickerOptions(context, state, picker.field);

  if (key.name === "enter") {
    const value = options[picker.cursor];

    if (value === undefined) {
      return { ...state, picker: undefined };
    }

    return setDraft(
      state,
      picker.field === "model" ? modelPatch(context, state, value) : { thinking: value },
    );
  }

  const cursor = listStep(key, picker.cursor, options.length);

  return cursor === undefined ? state : { ...state, picker: { ...picker, cursor } };
};

const chooseSkills = (
  context: SetupContext,
  state: SetupState,
  picker: SkillsPicker,
  key: KeyPress,
): SetupState => {
  if (key.name !== "enter") {
    const multi = multiKey(key, picker.multi);
    const touched = picker.touched || multi?.checked !== picker.multi.checked;

    return multi ? { ...state, picker: { ...picker, multi, touched } } : state;
  }

  if (context.skills.length === 0) {
    return { ...state, picker: undefined };
  }

  const shown = pickerSkills(context, picker);
  const names = checkedIndexes(picker.multi).flatMap((position) => shown[position]?.name ?? []);
  const keptAll = state.drafts[state.tab]?.skills === AGENT_SCOPE_ALL && !picker.touched;

  return setDraft(state, { skills: keptAll ? AGENT_SCOPE_ALL : names });
};

const pickerKey = (context: SetupContext, state: SetupState, picker: Picker, key: KeyPress): SetupState => {
  if (key.name === "escape") {
    return { ...state, picker: undefined };
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

const agentKey = (context: SetupContext, state: SetupState, key: KeyPress): SetupState => {
  if (key.name === "enter") {
    return openPicker(context, state);
  }

  const field = listStep(key, state.field, FIELDS.length);

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
