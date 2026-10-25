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
import type { AgentKind } from "../../core/agent-setup/agent-template.ts";
import { SCOPES } from "../../core/agent-setup/scope.ts";
import { grantOrNone } from "../../core/model/agent-record.ts";
import { AGENT_SCOPE_ALL, ALL_SKILLS_TEXT, INHERIT_MODEL } from "../../core/model/agent-schema.ts";
import { alignRight } from "../components/format.ts";
import {
  BLOCK_ROWS,
  changeRows,
  DETAIL_LINES,
  FIELD_ROWS,
  type Field,
  fieldChanged,
  fieldsOf,
  fieldValue,
  INFO_ROWS,
  listHeight,
  listView,
  onSubmitTab,
  type Picker,
  PRESETS,
  type Preset,
  presetFieldsOf,
  presetInUse,
  presetsOf,
  type SetupContext,
  type SetupState,
  scopeOptions,
  selectedRow,
  setupChanges,
  skillsView,
} from "./form.ts";

export type SetupPaths = { project: string; user: string };

const LABELS: Record<Field, string> = { model: "Model", thinking: "Thinking", skills: "Skills" };

const PRESET_LABELS: Record<Preset, string> = { previous: "Previous", suggested: "Suggested" };

const LABEL_WIDTH = 10;

const DESCRIPTION_ROWS = 2;

const BODY_ROWS = 1 + DESCRIPTION_ROWS + 1 + BLOCK_ROWS;

const TITLES: Record<Field, string> = {
  model: "Model (models with credentials)",
  thinking: "Thinking level",
  skills: "Skills",
};

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

  if (field === "skills" && draft.skills === AGENT_SCOPE_ALL) {
    return `${AGENT_SCOPE_ALL} (${ALL_SKILLS_TEXT})`;
  }

  if (field === "skills" && context.skills.length === 0) {
    return "none (no skills available)";
  }

  return fieldValue(field, draft);
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
  ...fieldsOf(context.agents[state.tab]).map((field) => {
    const chosen = selectedRow(context, state) === field;
    const label = theme.fg(chosen ? "accent" : "muted", LABELS[field].padEnd(LABEL_WIDTH));
    const changed = fieldChanged(context, state, field) ? theme.fg("warning", " (changed)") : "";
    const first = `${PAD}${pointerMark(theme, chosen)} ${label}`;

    return fitted(theme, first, theme.fg("text", valueText(context, state, field)), changed, width);
  }),
  ...lockedSkillsLines(context, state, theme, width),
];

const presetLines = (context: SetupContext, state: SetupState, theme: ThemeLike, width: number) => {
  const agent = context.agents[state.tab];

  if (!agent) {
    return [];
  }

  return presetsOf(agent).map(({ preset, draft }) => {
    const chosen = selectedRow(context, state) === preset;
    const label = theme.fg(chosen ? "accent" : "muted", PRESET_LABELS[preset].padEnd(LABEL_WIDTH));
    const first = `${PAD}${pointerMark(theme, chosen)} ${label}`;
    const text = presetFieldsOf(agent)
      .map((field) => fieldValue(field, draft))
      .join(DOT);
    const mark = presetInUse(context, state, preset) ? theme.fg("dim", " (in use)") : "";

    return fitted(theme, first, theme.fg("text", text), mark, width);
  });
};

const windowLines = (
  theme: ThemeLike,
  options: string[],
  cursor: number,
  width: number,
  height: number,
  empty: string | undefined,
  label: (option: string) => string = (option) => option,
) =>
  scrolledLines(
    theme,
    options.length,
    cursor,
    height,
    width,
    (index, chosen) => {
      const text = theme.fg(chosen ? "accent" : "text", label(options[index] ?? ""));

      return [fitted(theme, `${PAD}${pointerMark(theme, chosen)} `, text, "", width)];
    },
    { slots: true, empty },
  );

const labelLine = (theme: ThemeLike, label: string, text: string, width: number) =>
  line(theme, `${theme.fg("muted", `${label}:`)} ${theme.fg("dim", text)}`, width);

const headLine = (theme: ThemeLike, picker: Picker, shown: number, total: number, width: number) => {
  const name = `${theme.fg("accent", theme.bold(TITLES[picker.field]))}  `;

  if (!picker.query) {
    return line(theme, `${name}${theme.fg("dim", "/ type to filter")}`, width);
  }

  const count = `${shown} of ${total}`;
  const cols = Math.max(1, width - PAD.length);
  const room = Math.max(1, cols - theme.width(name) - count.length - 2 - "/ ▏".length);
  const left = `${name}${theme.fg("dim", "/")} ${theme.fg("text", `${cutStart(picker.query, room, theme)}▏`)}`;
  const right = theme.fg("dim", count);

  return `${PAD}${alignRight(theme, left, right, cols) ?? theme.truncate(left, cols)}`;
};

const noMatch = (picker: Picker) => `no ${NOUNS[picker.field]} matches "${picker.query}"`;

const pickerList = (
  context: SetupContext,
  state: SetupState,
  picker: Picker,
  theme: ThemeLike,
  width: number,
) => {
  const height = listHeight(picker.field);
  const empty = picker.query ? noMatch(picker) : undefined;

  if (picker.field === "skills") {
    const { options, multi, total, detail } = skillsView(context, picker);

    return {
      shown: options.length,
      total,
      lines: [
        ...multiLines(theme, options, multi, width, height, { slots: true, empty }),
        ...block(theme, detail ?? "", width, DETAIL_LINES),
      ],
    };
  }

  const { shown, total } = listView(context, state, picker);
  const label = picker.field === "model" ? modelText : undefined;

  return {
    shown: shown.length,
    total,
    lines: windowLines(theme, shown, picker.cursor, width, height, empty, label),
  };
};

const pickerLines = (
  context: SetupContext,
  state: SetupState,
  picker: Picker,
  theme: ThemeLike,
  width: number,
) => {
  const { shown, total, lines } = pickerList(context, state, picker, theme, width);

  return [headLine(theme, picker, shown, total, width), ...lines];
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

  const heading = [
    line(theme, theme.fg("accent", theme.bold(agent.name)), width),
    ...block(theme, agent.description, width, DESCRIPTION_ROWS),
    "",
  ];
  const rows = state.picker
    ? pickerLines(context, state, state.picker, theme, width)
    : [
        ...padRows(fieldLines(context, state, theme, width), FIELD_ROWS),
        "",
        ...padRows(presetLines(context, state, theme, width), PRESETS.length),
        "",
        ...padRows(infoLines(context, state, theme, width), INFO_ROWS),
      ];

  return padRows([...heading, ...rows], BODY_ROWS);
};

const changeLines = (context: SetupContext, state: SetupState, theme: ThemeLike, width: number) =>
  changeRows(context, state).map((change) => {
    const first = `${PAD}${theme.fg("muted", `${change.name}:`)} `;
    const suggested = change.suggested ? " (suggested)" : "";
    const suffix = theme.fg("text", `${suggested} (was ${change.was})`);

    return fitted(theme, first, theme.fg("text", `${change.field} ${change.value}`), suffix, width);
  });

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
  paths: SetupPaths,
  theme: ThemeLike,
  width: number,
) => {
  const texts = changeLines(context, state, theme, width);
  const scopes = scopeOptions(context).map((scope) => ({
    label: scope === "project" ? "This project" : "User",
    description: paths[scope],
  }));
  const top = [
    line(theme, theme.fg("accent", theme.bold("Submit")), width),
    context.project ? labelLine(theme, "Project", context.project, width) : "",
    line(theme, theme.fg("accent", theme.bold(texts.length > 0 ? "Changes" : "No changes")), width),
  ];
  const bottom = [
    "",
    line(theme, theme.fg("muted", "Save to:"), width),
    ...padRows(
      [
        ...listLines(theme, scopes, state.scope, width, { layout: "beside", cut: true }),
        ...(context.trusted ? [] : [line(theme, theme.fg("dim", UNTRUSTED_NOTE), width)]),
      ],
      SCOPES.length + 1,
    ),
  ];
  const window = changeWindow(theme, texts, BODY_ROWS - top.length - bottom.length, width);

  return [...top, ...window, ...bottom];
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
  const group = (label: string, role: AgentKind) => ({
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
    ? submitLines(context, state, paths, theme, width)
    : agentLines(context, state, theme, width);

  return framed(theme, width, [...bar, "", ...body], hints(context, state, ready), { oneRow: true });
};
