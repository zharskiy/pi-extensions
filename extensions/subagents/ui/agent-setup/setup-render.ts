import { PAD, type ThemeLike } from "../../../../platform/pi-adapter/index.ts";
import { cutStart, DOT, fixedBlock, padRows } from "../../../../platform/shared/index.ts";
import {
  CANCEL_HINT,
  countLine,
  framed,
  groupedTabBar,
  type KeyHint,
  listLines,
  multiLines,
  pointerMark,
  scrolledLines,
  TAB_SWITCH_HINT,
} from "../../../../platform/ui-kit/index.ts";
import type { SetupChange } from "../../core/agent-setup/scope.ts";
import { grantOrNone } from "../../core/model/agent-record.ts";
import { AGENT_SCOPE_ALL, INHERIT_MODEL } from "../../core/model/agent-schema.ts";
import { alignRight } from "../components/format.ts";
import {
  ALL_ROW,
  ALL_SKILLS_TEXT,
  type Draft,
  type Field,
  fieldChanged,
  fieldsOf,
  LIST_HEIGHT,
  listView,
  onSubmitTab,
  type Picker,
  type Preset,
  presetInUse,
  presetOf,
  rowsOf,
  type SetupContext,
  type SetupState,
  sameField,
  scopeOptions,
  setupChanges,
  skillsView,
} from "./form.ts";

export type SetupPaths = { project: string; user: string };

const LABELS: Record<Field, string> = { model: "Model", thinking: "Thinking", skills: "Skills" };

const PRESET_LABELS: Record<Preset, string> = { previous: "Previous", suggested: "Suggested" };

const PRESETS: readonly Preset[] = ["previous", "suggested"];

const LABEL_WIDTH = 10;

const DESCRIPTION_ROWS = 2;

const DETAIL_LINES = 3;

const FIELD_ROWS = 3;

const PANEL_ROWS = 1 + 1 + (LIST_HEIGHT + 2) + 1 + DETAIL_LINES;

const BODY_ROWS = 1 + DESCRIPTION_ROWS + 1 + FIELD_ROWS + 1 + PRESETS.length + 1 + PANEL_ROWS;

const WIDE = 10_000;

const NOUNS: Record<Field, string> = { model: "model", thinking: "level", skills: "skill" };

const TOOLS_NOTE = "fixed per agent; /agents create makes your own";

const MCP_ON = "on: the MCP servers in mcp.json, shared by every agent with mcp: true";

const MCP_OFF = "off: this agent does not see MCP servers";

const CHORE_SKILLS_NOTE = "fixed for chores";

const UNTRUSTED_NOTE = "Project not trusted: only the user file applies, to every project.";

const fitted = (theme: ThemeLike, first: string, text: string, suffix: string, width: number) =>
  theme.truncate(
    `${first}${theme.truncate(text, Math.max(1, width - theme.width(first) - theme.width(suffix)))}${suffix}`,
    width,
  );

const line = (theme: ThemeLike, text: string, width: number) => fitted(theme, PAD, text, "", width);

const block = (theme: ThemeLike, text: string, width: number, rows: number) =>
  fixedBlock(theme, text, Math.max(1, width - PAD.length), rows).map((row) =>
    row ? `${PAD}${theme.fg("muted", row)}` : "",
  );

const modelText = (model: string) => (model === INHERIT_MODEL ? "inherit (the main session's model)" : model);

const valueText = (context: SetupContext, state: SetupState, field: Field) => {
  const draft = state.drafts[state.tab];

  if (!draft) {
    return "";
  }

  if (field === "model") {
    return modelText(draft.model);
  }

  if (field === "thinking") {
    return draft.thinking ?? "default";
  }

  if (draft.skills === AGENT_SCOPE_ALL) {
    return `${AGENT_SCOPE_ALL} (${ALL_SKILLS_TEXT})`;
  }

  return context.skills.length === 0 ? "none (no skills available)" : grantOrNone(draft.skills);
};

const lockedSkillsLines = (context: SetupContext, state: SetupState, theme: ThemeLike, width: number) => {
  const agent = context.agents[state.tab];

  if (agent?.role !== "chore") {
    return [];
  }

  const label = theme.fg("dim", LABELS.skills.padEnd(LABEL_WIDTH));
  const value = theme.fg("dim", `${grantOrNone(agent.initial.skills)} · ${CHORE_SKILLS_NOTE}`);

  return [fitted(theme, `${PAD}${pointerMark(theme, false)} ${label}`, value, "", width)];
};

const fieldLines = (context: SetupContext, state: SetupState, theme: ThemeLike, width: number) => [
  ...fieldsOf(context.agents[state.tab]).map((field, index) => {
    const chosen = index === state.field && !state.picker;
    const label = theme.fg(chosen ? "accent" : "muted", LABELS[field].padEnd(LABEL_WIDTH));
    const changed = fieldChanged(context, state, state.tab, field) ? theme.fg("warning", " (changed)") : "";
    const first = `${PAD}${pointerMark(theme, chosen)} ${label}`;

    return fitted(theme, first, theme.fg("text", valueText(context, state, field)), changed, width);
  }),
  ...lockedSkillsLines(context, state, theme, width),
];

const fieldText = (field: Field, draft: Draft) => {
  if (field === "model") {
    return draft.model;
  }

  return field === "thinking" ? (draft.thinking ?? "default") : grantOrNone(draft.skills);
};

const presetOrder = (fields: readonly Field[]): readonly Field[] =>
  fields.includes("skills") ? ["skills", ...fields.filter((field) => field !== "skills")] : fields;

const presetText = (fields: readonly Field[], draft: Draft) =>
  presetOrder(fields)
    .map((field) => fieldText(field, draft))
    .join(DOT);

const presetLines = (context: SetupContext, state: SetupState, theme: ThemeLike, width: number) => {
  const agent = context.agents[state.tab];

  if (!agent) {
    return [];
  }

  const rows = rowsOf(agent);

  return PRESETS.map((preset) => {
    const draft = presetOf(agent, preset);
    const index = rows.indexOf(preset);

    if (!draft || index < 0) {
      return "";
    }

    const chosen = index === state.field && !state.picker;
    const label = theme.fg(chosen ? "accent" : "muted", PRESET_LABELS[preset].padEnd(LABEL_WIDTH));
    const first = `${PAD}${pointerMark(theme, chosen)} ${label}`;
    const mark = presetInUse(context, state, preset) ? theme.fg("dim", " (in use)") : "";

    return fitted(theme, first, theme.fg("text", presetText(fieldsOf(agent), draft)), mark, width);
  });
};

const windowLines = (
  theme: ThemeLike,
  options: string[],
  cursor: number,
  width: number,
  label: (option: string) => string = (option) => option,
) =>
  scrolledLines(
    theme,
    options.length,
    cursor,
    LIST_HEIGHT,
    width,
    (index, chosen) => {
      const text = theme.fg(chosen ? "accent" : "text", label(options[index] ?? ""));

      return [fitted(theme, `${PAD}${pointerMark(theme, chosen)} `, text, "", width)];
    },
    { slots: true },
  );

const emptyList = (theme: ThemeLike, text: string, width: number) =>
  padRows(["", line(theme, theme.fg("muted", text), width)], LIST_HEIGHT + 2);

const labelLine = (theme: ThemeLike, label: string, text: string, width: number) =>
  line(theme, `${theme.fg("muted", `${label}:`)} ${theme.fg("dim", text)}`, width);

const skillDetail = (description: string | undefined, theme: ThemeLike, width: number) =>
  block(theme, description ?? "", width, DETAIL_LINES);

const queryLine = (theme: ThemeLike, query: string, shown: number, total: number, width: number) => {
  if (!query) {
    return line(theme, theme.fg("dim", "/ type to filter"), width);
  }

  const count = `${shown} of ${total}`;
  const cols = Math.max(1, width - PAD.length);
  const room = Math.max(1, cols - count.length - 2 - "/ ▏".length);
  const left = `${theme.fg("dim", "/")} ${theme.fg("text", `${cutStart(query, room, theme)}▏`)}`;
  const right = theme.fg("dim", count);

  return `${PAD}${alignRight(theme, left, right, cols) ?? theme.truncate(left, cols)}`;
};

const noMatch = (picker: Picker) => `no ${NOUNS[picker.field]} matches "${picker.query}"`;

const pickerLines = (
  context: SetupContext,
  state: SetupState,
  picker: Picker,
  theme: ThemeLike,
  width: number,
) => {
  const title = (text: string) => line(theme, theme.fg("accent", theme.bold(text)), width);

  if (picker.field === "skills") {
    const { rows, options, multi, total } = skillsView(context, picker);
    const list =
      options.length === 0 && picker.query
        ? emptyList(theme, noMatch(picker), width)
        : multiLines(theme, options, multi, width, LIST_HEIGHT, { slots: true });
    const detail = rows[multi.cursor] === ALL_ROW ? undefined : options[multi.cursor]?.description;

    return [
      title("Skills"),
      queryLine(theme, picker.query, options.length, total, width),
      ...list,
      "",
      ...skillDetail(detail, theme, width),
    ];
  }

  const { shown, total } = listView(context, state, picker);
  const label = picker.field === "model" ? modelText : undefined;
  const list =
    shown.length === 0
      ? emptyList(theme, picker.query ? noMatch(picker) : "(none available)", width)
      : windowLines(theme, shown, picker.cursor, width, label);

  return [
    title(picker.field === "model" ? "Model (models with credentials)" : "Thinking level"),
    queryLine(theme, picker.query, shown.length, total, width),
    ...list,
  ];
};

const infoLines = (context: SetupContext, state: SetupState, theme: ThemeLike, width: number) => {
  const agent = context.agents[state.tab];

  if (!agent) {
    return [];
  }

  return [
    agent.note ? labelLine(theme, "Proposed", agent.note, width) : "",
    labelLine(theme, "Tools", `${grantOrNone(agent.tools)}; ${TOOLS_NOTE}`, width),
    labelLine(theme, "MCP", agent.mcp ? MCP_ON : MCP_OFF, width),
  ];
};

const agentLines = (context: SetupContext, state: SetupState, theme: ThemeLike, width: number) => {
  const agent = context.agents[state.tab];

  if (!agent) {
    return [];
  }

  const below = state.picker
    ? pickerLines(context, state, state.picker, theme, width)
    : infoLines(context, state, theme, width);

  return [
    line(theme, theme.fg("accent", theme.bold(agent.name)), width),
    ...block(theme, agent.description, width, DESCRIPTION_ROWS),
    "",
    ...fieldLines(context, state, theme, width),
    "",
    ...presetLines(context, state, theme, width),
    "",
    ...padRows(below, PANEL_ROWS),
  ];
};

const changeLines = (
  context: SetupContext,
  state: SetupState,
  change: SetupChange,
  theme: ThemeLike,
  width: number,
) => {
  const index = context.agents.findIndex((agent) => agent.name === change.name);
  const agent = context.agents[index];
  const draft = state.drafts[index];

  if (!agent || !draft) {
    return [];
  }

  return fieldsOf(agent)
    .filter((field) => field in change.patch)
    .map((field) => {
      const suggested = agent.proposed && sameField(field, agent.proposed, draft) ? " (suggested)" : "";
      const first = `${PAD}${theme.fg("muted", `${agent.name}:`)} `;
      const suffix = theme.fg("text", `${suggested} (was ${fieldText(field, agent.initial)})`);

      return fitted(theme, first, theme.fg("text", `${field} ${fieldText(field, draft)}`), suffix, width);
    });
};

const changeWindow = (theme: ThemeLike, texts: string[], rows: number, width: number) => {
  if (texts.length <= rows) {
    return padRows(texts, rows);
  }

  const kept = texts.slice(0, Math.max(0, rows - 1));
  const more = countLine(
    { hidden: texts.length - kept.length, end: "more", noun: "item" },
    width - PAD.length,
    theme,
  );

  return [...kept, `${PAD}${more}`];
};

const submitLines = (
  context: SetupContext,
  state: SetupState,
  changes: SetupChange[],
  paths: SetupPaths,
  theme: ThemeLike,
  width: number,
) => {
  const title = changes.length > 0 ? "Changes" : "No changes";
  const texts = changes.flatMap((change) => changeLines(context, state, change, theme, width));
  const project = context.project ? labelLine(theme, "Project", context.project, width) : "";
  const scopes = scopeOptions(context).map((scope) => ({
    label: scope === "project" ? "This project" : "User",
    description: paths[scope],
  }));
  const top = [
    line(theme, theme.fg("accent", theme.bold("Submit")), width),
    ...padRows([], DESCRIPTION_ROWS),
    "",
    project,
    "",
    line(theme, theme.fg("accent", theme.bold(title)), width),
  ];
  const bottom = [
    "",
    line(theme, theme.fg("muted", "Save to:"), width),
    ...listLines(theme, scopes, state.scope, WIDE, { layout: "beside" }).map((row) =>
      theme.truncate(row, width),
    ),
    context.trusted ? "" : line(theme, theme.fg("dim", UNTRUSTED_NOTE), width),
  ];
  const window = changeWindow(theme, texts, BODY_ROWS - top.length - bottom.length, width);

  return padRows([...top, ...window, ...bottom], BODY_ROWS);
};

const BACK_HINT: KeyHint = ["esc", "to clear/back"];

const SELECT_HINT: KeyHint = ["↑↓", "to select"];

const hints = (context: SetupContext, state: SetupState, ready: boolean): readonly KeyHint[] => {
  if (state.picker?.field === "skills") {
    return [BACK_HINT, SELECT_HINT, ["space", "to toggle"], ["enter", "to confirm"]];
  }

  if (state.picker) {
    return [BACK_HINT, SELECT_HINT, ["enter", "to choose"]];
  }

  if (onSubmitTab(context, state)) {
    return [CANCEL_HINT, SELECT_HINT, ["enter", ready ? "to save" : "to close"], TAB_SWITCH_HINT];
  }

  return [CANCEL_HINT, SELECT_HINT, ["enter", "to change or apply"], TAB_SWITCH_HINT];
};

export const renderSetup = (
  context: SetupContext,
  state: SetupState,
  paths: SetupPaths,
  theme: ThemeLike,
  width: number,
) => {
  const changes = setupChanges(context, state);
  const group = (label: string, role: "lead" | "chore") => ({
    label,
    tabs: context.agents.flatMap((agent) =>
      agent.role === role
        ? [{ label: agent.name, done: changes.some((change) => change.name === agent.name) }]
        : [],
    ),
  });
  const ready = changes.length > 0;
  const groups = [group("Leads", "lead"), group("Chores", "chore")];
  const bar = groupedTabBar(theme, groups, state.tab, ready, width - PAD.length).map((row) => `${PAD}${row}`);
  const body = onSubmitTab(context, state)
    ? submitLines(context, state, changes, paths, theme, width)
    : agentLines(context, state, theme, width);

  return framed(theme, width, [...bar, "", ...body], hints(context, state, ready), { hintRows: 1 });
};
