import type { ThemeLike } from "../../../../../core/adapter/contract.ts";
import { hintLines, PAD, padded, prefixed, rule } from "../../../../../core/manager/layout.ts";
import { CANCEL_HINT, listLines, SELECT_HINTS } from "../../../../../core/manager/list.ts";
import { MULTI_SELECT_HINTS, multiLines, scrollWindow } from "../../../../../core/manager/multi-select.ts";
import { TAB_SWITCH_HINT, tabBar } from "../../../../../core/manager/tabs.ts";
import { INHERIT_MODEL } from "../../model/agent-schema.ts";
import {
  FIELDS,
  type Field,
  fieldChanged,
  grantText,
  LIST_HEIGHT,
  modelOptions,
  onSubmitTab,
  type Picker,
  SCOPES,
  type SetupChange,
  type SetupContext,
  type SetupState,
  setupChanges,
  thinkingOptions,
} from "./form.ts";

export type SetupPaths = { project: string; user: string };

const LABELS: Record<Field, string> = { model: "Model", thinking: "Thinking", skills: "Skills" };

const LABEL_WIDTH = 10;

const TOOLS_NOTE = "Tools are fixed per agent. To change tools, create your own agent with /agents create.";

const MCP_ON = "on: the MCP servers configured in mcp.json, shared by every agent with mcp: true";

const MCP_OFF = "off: this agent does not see MCP servers";

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

  const none = context.skills.length === 0 && draft.skills !== "all";

  return none ? "none (no skills loaded)" : grantText(draft.skills);
};

const fieldLines = (context: SetupContext, state: SetupState, theme: ThemeLike, width: number) =>
  FIELDS.flatMap((field, index) => {
    const chosen = index === state.field && !state.picker;
    const pointer = chosen ? theme.fg("accent", theme.bold("›")) : " ";
    const label = theme.fg(chosen ? "accent" : "muted", LABELS[field].padEnd(LABEL_WIDTH));
    const changed = fieldChanged(context, state, state.tab, field) ? theme.fg("warning", " (changed)") : "";
    const value = `${theme.fg("text", valueText(context, state, field))}${changed}`;

    return prefixed(theme, `${PAD}${pointer} ${label}`, value, width);
  });

const windowLines = (
  theme: ThemeLike,
  options: string[],
  cursor: number,
  width: number,
  label: (option: string) => string = (option) => option,
) => {
  const { start, end } = scrollWindow(options.length, cursor, LIST_HEIGHT);
  const more = (text: string) => padded(theme, theme.fg("dim", text), width);

  const rows = options.slice(start, end).flatMap((option, offset) => {
    const chosen = start + offset === cursor;
    const pointer = chosen ? theme.fg("accent", theme.bold("›")) : " ";

    return prefixed(theme, `${PAD}${pointer} `, theme.fg(chosen ? "accent" : "text", label(option)), width);
  });

  return [
    ...(start > 0 ? more(`↑ ${start} more`) : []),
    ...rows,
    ...(end < options.length ? more(`↓ ${options.length - end} more`) : []),
  ];
};

const pickerLines = (
  context: SetupContext,
  state: SetupState,
  picker: Picker,
  theme: ThemeLike,
  width: number,
) => {
  const title = (text: string) => ["", ...padded(theme, theme.fg("accent", theme.bold(text)), width)];

  if (picker.field === "skills") {
    const options = context.skills.map((label) => ({ label }));

    return [...title("Skills"), ...multiLines(theme, options, picker.multi, width, LIST_HEIGHT)];
  }

  if (picker.field === "model") {
    const rows = windowLines(theme, modelOptions(context, state.tab), picker.cursor, width, modelText);

    return [...title("Model (models with credentials)"), ...rows];
  }

  const levels = thinkingOptions(context, state.drafts[state.tab]);

  return [...title("Thinking level"), ...windowLines(theme, levels, picker.cursor, width)];
};

const infoLines = (context: SetupContext, state: SetupState, theme: ThemeLike, width: number) => {
  const agent = context.agents[state.tab];

  if (!agent) {
    return [];
  }

  const line = (label: string, text: string) =>
    padded(theme, `${theme.fg("muted", `${label}:`)} ${theme.fg("dim", text)}`, width);

  return [
    "",
    ...line("Tools", `${grantText(agent.tools)}. ${TOOLS_NOTE}`),
    ...line("MCP", agent.mcp ? MCP_ON : MCP_OFF),
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
    .map(([field, value]) => `${field} ${Array.isArray(value) ? grantText(value) : String(value)}`)
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
  const scopes = SCOPES.map((scope) => ({
    label: scope === "project" ? "This project" : "User",
    description: context.trusted || scope === "user" ? paths[scope] : `${paths[scope]} (project not trusted)`,
  }));
  const refused = state.refused ? ["", ...padded(theme, theme.fg("warning", state.refused), width)] : [];

  return [
    ...padded(theme, theme.fg("accent", theme.bold(title)), width),
    ...(rows.length > 0 ? ["", ...rows] : []),
    "",
    ...padded(theme, theme.fg("muted", "Save to:"), width),
    ...listLines(theme, scopes, state.scope, width, { layout: "beside" }),
    ...refused,
  ];
};

const hints = (context: SetupContext, state: SetupState, ready: boolean) => {
  if (state.picker?.field === "skills") {
    return [...MULTI_SELECT_HINTS, "Enter confirm", "Esc back"];
  }

  if (state.picker) {
    return ["↑↓ select", "Enter choose", "Esc back"];
  }

  if (onSubmitTab(context, state)) {
    const enter = ready ? "Enter save" : "Enter close";

    return [...SELECT_HINTS, enter, TAB_SWITCH_HINT, CANCEL_HINT];
  }

  return ["↑↓ field", "Enter change", TAB_SWITCH_HINT, CANCEL_HINT];
};

export const renderSetup = (
  context: SetupContext,
  state: SetupState,
  paths: SetupPaths,
  theme: ThemeLike,
  width: number,
) => {
  const tabs = context.agents.map((agent, index) => ({
    label: agent.name,
    done: FIELDS.some((field) => fieldChanged(context, state, index, field)),
  }));
  const changes = setupChanges(context, state);
  const ready = changes.length > 0;
  const body = onSubmitTab(context, state)
    ? submitLines(context, state, changes, paths, theme, width)
    : agentLines(context, state, theme, width);

  return [
    rule(theme, width),
    ...padded(theme, tabBar(theme, tabs, state.tab, ready), width),
    "",
    ...body,
    "",
    ...hintLines(theme, hints(context, state, ready), width),
    rule(theme, width),
  ];
};
