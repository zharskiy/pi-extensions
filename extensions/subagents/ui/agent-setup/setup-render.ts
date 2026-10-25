import { PAD, type ThemeLike } from "../../../../platform/pi-adapter/index.ts";
import { padded, prefixed } from "../../../../platform/shared/index.ts";
import {
  CANCEL_HINT,
  descriptionFits,
  framed,
  groupedTabBar,
  type KeyHint,
  listLines,
  multiLines,
  pointerMark,
  SELECT_HINTS,
  scrolledLines,
  TAB_SWITCH_HINT,
} from "../../../../platform/ui-kit/index.ts";
import type { SetupChange } from "../../core/agent-setup/scope.ts";
import { grantOrNone } from "../../core/model/agent-record.ts";
import { AGENT_SCOPE_ALL, INHERIT_MODEL } from "../../core/model/agent-schema.ts";
import {
  ALL_SKILLS_TEXT,
  FIELDS,
  type Field,
  fieldChanged,
  fieldsOf,
  LIST_HEIGHT,
  listView,
  onSubmitTab,
  type Picker,
  type SetupContext,
  type SetupState,
  scopeOptions,
  setupChanges,
  skillsView,
} from "./form.ts";

export type SetupPaths = { project: string; user: string };

const LABELS: Record<Field, string> = { model: "Model", thinking: "Thinking", skills: "Skills" };

const LABEL_WIDTH = 10;

const DETAIL_LINES = 3;

const NOUNS: Record<Field, string> = { model: "model", thinking: "level", skills: "skill" };

const TOOLS_NOTE = "Tools are fixed per agent. To change tools, create your own agent with /agents create.";

const MCP_ON = "on: the MCP servers configured in mcp.json, shared by every agent with mcp: true";

const MCP_OFF = "off: this agent does not see MCP servers";

const CHORE_SKILLS_NOTE = "fixed for chores";

const UNTRUSTED_NOTE =
  "This project is not trusted, so pi does not read its .pi/pi-subagents.json; the user file applies to every project.";

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

  return prefixed(theme, `${PAD}${pointerMark(theme, false)} ${label}`, value, width);
};

const fieldLines = (context: SetupContext, state: SetupState, theme: ThemeLike, width: number) => [
  ...fieldsOf(context.agents[state.tab]).flatMap((field, index) => {
    const chosen = index === state.field && !state.picker;
    const label = theme.fg(chosen ? "accent" : "muted", LABELS[field].padEnd(LABEL_WIDTH));
    const changed = fieldChanged(context, state, state.tab, field) ? theme.fg("warning", " (changed)") : "";
    const value = `${theme.fg("text", valueText(context, state, field))}${changed}`;

    return prefixed(theme, `${PAD}${pointerMark(theme, chosen)} ${label}`, value, width);
  }),
  ...lockedSkillsLines(context, state, theme, width),
];

const windowLines = (
  theme: ThemeLike,
  options: string[],
  cursor: number,
  width: number,
  label: (option: string) => string = (option) => option,
) =>
  scrolledLines(theme, options.length, cursor, LIST_HEIGHT, width, (index, chosen) => {
    const text = theme.fg(chosen ? "accent" : "text", label(options[index] ?? ""));

    return prefixed(theme, `${PAD}${pointerMark(theme, chosen)} `, text, width);
  });

const labelLine = (theme: ThemeLike, label: string, text: string, width: number) =>
  padded(theme, `${theme.fg("muted", `${label}:`)} ${theme.fg("dim", text)}`, width);

const skillDetail = (
  options: { label: string; description?: string }[],
  cursor: number,
  theme: ThemeLike,
  width: number,
) => {
  const option = options[cursor];

  if (!option?.description || descriptionFits(theme, option, width)) {
    return [];
  }

  const cols = Math.max(1, width - PAD.length);
  const lines = theme.wrap(option.description, cols);
  const shown =
    lines.length > DETAIL_LINES
      ? [...lines.slice(0, DETAIL_LINES - 1), theme.truncate(lines.slice(DETAIL_LINES - 1).join(" "), cols)]
      : lines;

  return ["", ...shown.map((line) => `${PAD}${theme.fg("muted", line)}`)];
};

const queryLine = (theme: ThemeLike, query: string, shown: number, total: number, width: number) => {
  if (!query) {
    return padded(theme, theme.fg("dim", "/ type to filter"), width);
  }

  return padded(
    theme,
    `${theme.fg("dim", "/")} ${theme.fg("text", `${query}▏`)}   ${theme.fg("dim", `${shown} of ${total}`)}`,
    width,
  );
};

const noMatchLines = (theme: ThemeLike, picker: Picker, shown: number, width: number) =>
  picker.query && shown === 0
    ? padded(theme, theme.fg("muted", `no ${NOUNS[picker.field]} matches "${picker.query}"`), width)
    : [];

const pickerLines = (
  context: SetupContext,
  state: SetupState,
  picker: Picker,
  theme: ThemeLike,
  width: number,
) => {
  const title = (text: string) => ["", ...padded(theme, theme.fg("accent", theme.bold(text)), width)];

  if (picker.field === "skills") {
    const { options, multi, total } = skillsView(context, picker);
    const rows = options.length > 0 ? multiLines(theme, options, multi, width, LIST_HEIGHT) : [];

    return [
      ...title("Skills"),
      ...queryLine(theme, picker.query, options.length, total, width),
      ...rows,
      ...noMatchLines(theme, picker, options.length, width),
      ...skillDetail(options, multi.cursor, theme, width),
    ];
  }

  const { shown, total } = listView(context, state, picker);
  const label = picker.field === "model" ? modelText : undefined;

  return [
    ...title(picker.field === "model" ? "Model (models with credentials)" : "Thinking level"),
    ...queryLine(theme, picker.query, shown.length, total, width),
    ...windowLines(theme, shown, picker.cursor, width, label),
    ...noMatchLines(theme, picker, shown.length, width),
  ];
};

const infoLines = (context: SetupContext, state: SetupState, theme: ThemeLike, width: number) => {
  const agent = context.agents[state.tab];

  if (!agent) {
    return [];
  }

  const proposed = agent.note ? labelLine(theme, "Proposed", agent.note, width) : [];

  return [
    "",
    ...proposed,
    ...labelLine(theme, "Tools", `${grantOrNone(agent.tools)}. ${TOOLS_NOTE}`, width),
    ...labelLine(theme, "MCP", agent.mcp ? MCP_ON : MCP_OFF, width),
  ];
};

const agentLines = (context: SetupContext, state: SetupState, theme: ThemeLike, width: number) => {
  const agent = context.agents[state.tab];

  if (!agent) {
    return [];
  }

  const heading = `${theme.fg("accent", theme.bold(agent.name))} ${theme.fg("muted", agent.description)}`;
  const below = state.picker
    ? pickerLines(context, state, state.picker, theme, width)
    : infoLines(context, state, theme, width);

  return [...padded(theme, heading, width), "", ...fieldLines(context, state, theme, width), ...below];
};

const changeText = (patch: Record<string, unknown>) =>
  Object.entries(patch)
    .map(([field, value]) => `${field} ${Array.isArray(value) ? grantOrNone(value) : String(value)}`)
    .join(", ");

const submitLines = (
  context: SetupContext,
  state: SetupState,
  changes: SetupChange[],
  paths: SetupPaths,
  theme: ThemeLike,
  width: number,
) => {
  const title = changes.length > 0 ? "Changes" : "No changes";
  const rows = changes.flatMap((change) => {
    const text = `${theme.fg("muted", `${change.name}:`)} ${theme.fg("text", changeText(change.patch))}`;

    return padded(theme, text, width);
  });
  const project = context.project ? [...labelLine(theme, "Project", context.project, width), ""] : [];
  const scopes = scopeOptions(context).map((scope) => ({
    label: scope === "project" ? "This project" : "User",
    description: paths[scope],
  }));
  const untrusted = context.trusted ? [] : padded(theme, theme.fg("dim", UNTRUSTED_NOTE), width);

  return [
    ...project,
    ...padded(theme, theme.fg("accent", theme.bold(title)), width),
    ...(rows.length > 0 ? ["", ...rows] : []),
    "",
    ...padded(theme, theme.fg("muted", "Save to:"), width),
    ...listLines(theme, scopes, state.scope, width, { layout: "beside" }),
    ...untrusted,
  ];
};

const FILTER_HINTS: readonly KeyHint[] = [
  ["type", "to filter"],
  ["↑↓", "to select"],
];

const BACK_HINT: KeyHint = ["esc", "to clear/back"];

const hints = (context: SetupContext, state: SetupState, ready: boolean): readonly KeyHint[] => {
  if (state.picker?.field === "skills") {
    return [...FILTER_HINTS, ["space", "to toggle"], ["enter", "to confirm"], BACK_HINT];
  }

  if (state.picker) {
    return [...FILTER_HINTS, ["enter", "to choose"], BACK_HINT];
  }

  if (onSubmitTab(context, state)) {
    const enter: KeyHint = ["enter", ready ? "to save" : "to close"];

    return [...SELECT_HINTS, enter, TAB_SWITCH_HINT, CANCEL_HINT];
  }

  return [["↑↓", "to select a field"], ["enter", "to change"], TAB_SWITCH_HINT, CANCEL_HINT];
};

export const renderSetup = (
  context: SetupContext,
  state: SetupState,
  paths: SetupPaths,
  theme: ThemeLike,
  width: number,
) => {
  const group = (label: string, role: "lead" | "chore") => ({
    label,
    tabs: context.agents.flatMap((agent, index) =>
      agent.role === role
        ? [{ label: agent.name, done: FIELDS.some((field) => fieldChanged(context, state, index, field)) }]
        : [],
    ),
  });
  const changes = setupChanges(context, state);
  const ready = changes.length > 0;
  const body = onSubmitTab(context, state)
    ? submitLines(context, state, changes, paths, theme, width)
    : agentLines(context, state, theme, width);

  return framed(
    theme,
    width,
    [
      ...groupedTabBar(theme, [group("Leads", "lead"), group("Chores", "chore")], state.tab, ready, width),
      "",
      ...body,
    ],
    hints(context, state, ready),
  );
};
