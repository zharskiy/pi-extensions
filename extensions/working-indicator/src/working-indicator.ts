import { homedir } from "node:os";
import { isAbsolute, relative, sep } from "node:path";
import type { Host, Phase, PhaseDetail, RunningTool } from "../../../core/adapter/contract.ts";
import { formatDuration, homeRelative } from "../../../core/manager/format.ts";
import { DOT } from "../../../core/manager/layout.ts";
import { ELLIPSIS } from "../../../core/manager/row.ts";

export const TICK_MS = 1000;

const INTERRUPT_BINDING = "app.interrupt";

const SPINNER_COLUMNS = 2;

const BORDER_COLUMNS = 5;

const FRAME_COLUMNS = 3;

const MIN_ACTIVITY = 12;

const MCP_NAME = /^mcp__(.+?)__(.+)$/;

type Cut = "start" | "end";

type Activity = { verb: string; target?: string; cut?: Cut };

type Args = Record<string, unknown>;

type Place = { cwd: string; home: string };

const PATH_VERBS: Record<string, string> = { read: "Reading", edit: "Editing", write: "Writing" };

const PATTERN_VERBS: Record<string, string> = { grep: "Searching", find: "Finding" };

const SHELLS = new Set(["bash", "powershell"]);

const argsOf = (tool: RunningTool): Args =>
  typeof tool.args === "object" && tool.args !== null ? (tool.args as Args) : {};

const textArg = (value: unknown) => (typeof value === "string" && value.trim() !== "" ? value : undefined);

const shortPath = (path: string, place: Place) => {
  if (place.cwd && isAbsolute(path) && (path === place.cwd || path.startsWith(`${place.cwd}${sep}`))) {
    return relative(place.cwd, path) || ".";
  }

  return homeRelative(path, place.home);
};

const firstLine = (text: string) => text.trim().split("\n")[0]?.trim() ?? "";

const agentCount = (args: Args) => (Array.isArray(args.agents) ? Math.max(1, args.agents.length) : 1);

const toolActivity = (tool: RunningTool, place: Place): Activity => {
  const args = argsOf(tool);
  const path = textArg(args.path);
  const pattern = textArg(args.pattern);
  const command = textArg(args.command);
  const mcp = tool.label ?? tool.name.match(MCP_NAME)?.slice(1, 3).join("/");

  if (PATH_VERBS[tool.name] && path) {
    return { verb: PATH_VERBS[tool.name] ?? "", target: shortPath(path, place), cut: "start" };
  }

  if (SHELLS.has(tool.name) && command) {
    return { verb: "Running", target: firstLine(command), cut: "end" };
  }

  if (PATTERN_VERBS[tool.name] && pattern) {
    return { verb: PATTERN_VERBS[tool.name] ?? "", target: pattern, cut: "end" };
  }

  if (tool.name === "ls") {
    return { verb: "Listing", target: shortPath(path ?? ".", place), cut: "start" };
  }

  if (tool.name === "codemode") {
    return { verb: "Running codemode" };
  }

  if (tool.name === "run_agent" && args.wait === true) {
    const count = agentCount(args);

    return { verb: `Waiting for ${count} ${count === 1 ? "agent" : "agents"}` };
  }

  if (mcp) {
    return { verb: "Calling", target: mcp, cut: "end" };
  }

  return { verb: "Running", target: tool.name, cut: "end" };
};

export const activityOf = (phase: Phase, detail: PhaseDetail, place: Place): Activity => {
  const tools = detail.tools ?? (detail.toolName ? [{ name: detail.toolName, args: {} }] : []);

  if (phase === "thinking") {
    return { verb: "Thinking" };
  }

  if (phase !== "tool" || tools.length === 0) {
    return { verb: "Waiting for the model" };
  }

  if (tools.length > 1) {
    return { verb: `Running ${tools.length} tools` };
  }

  return toolActivity(tools[0] as RunningTool, place);
};

const columnsOf = (text: string) => [...text].length;

const cutEnd = (text: string, cols: number) => {
  const chars = [...text];

  if (chars.length <= cols) {
    return text;
  }

  return cols <= ELLIPSIS.length
    ? ELLIPSIS.slice(0, cols)
    : `${chars.slice(0, cols - ELLIPSIS.length).join("")}${ELLIPSIS}`;
};

const cutHead = (text: string, cols: number) => {
  const chars = [...text];

  return chars.length <= cols
    ? text
    : `${ELLIPSIS}${chars.slice(chars.length - (cols - ELLIPSIS.length)).join("")}`;
};

const activityText = (activity: Activity) =>
  activity.target === undefined ? activity.verb : `${activity.verb} ${activity.target}`;

const fitActivity = (activity: Activity, cols: number) => {
  const full = activityText(activity);

  if (columnsOf(full) <= cols) {
    return full;
  }

  const targetRoom = cols - columnsOf(activity.verb) - 1;

  if (activity.target === undefined || activity.cut !== "start" || targetRoom <= ELLIPSIS.length) {
    return cutEnd(full, cols);
  }

  return `${activity.verb} ${cutHead(activity.target, targetRoom)}`;
};

export type WorkingParts = {
  activity: Activity;
  elapsedMs: number;
  hint: string;
  columns: number | undefined;
};

export const workingText = (parts: WorkingParts, dim: (text: string) => string) => {
  const elapsed = parts.elapsedMs >= TICK_MS ? `${DOT}${formatDuration(parts.elapsedMs)}` : "";
  const hint = parts.hint ? ` ${parts.hint}` : "";
  const full = activityText(parts.activity);
  const compose = (activity: string, withHint: boolean) =>
    `${activity}${elapsed}${withHint && hint ? dim(hint) : ""}`;

  if (parts.columns === undefined) {
    return compose(full, true);
  }

  const room = parts.columns - FRAME_COLUMNS - BORDER_COLUMNS - SPINNER_COLUMNS;
  const hinted = room - columnsOf(elapsed) - columnsOf(hint);

  if (hinted >= columnsOf(full) || (hint && hinted >= MIN_ACTIVITY)) {
    return compose(fitActivity(parts.activity, hinted), true);
  }

  const bare = room - columnsOf(elapsed);

  return compose(fitActivity(parts.activity, Math.max(bare, ELLIPSIS.length + 1)), false);
};

type Run = {
  startedAt: number;
  hint: string;
  timer: ReturnType<typeof setInterval>;
};

export const createWorkingIndicator = (host: Host, home = homedir()) => {
  let run: Run | undefined;
  let phase: Phase = "waiting";
  let detail: PhaseDetail = {};
  let place: Place = { cwd: "", home };
  let hidden = false;
  let written: string | undefined;

  const write = (active: Run) => {
    const text = workingText(
      {
        activity: activityOf(phase, detail, place),
        elapsedMs: Date.now() - active.startedAt,
        hint: active.hint,
        columns: host.ui.terminalColumns(),
      },
      (hint) => host.ui.style("dim", hint),
    );

    if (text === written) {
      return;
    }

    written = text;
    host.ui.setWorkingMessage(text);
  };

  const tick = () => {
    if (run) {
      write(run);
    }
  };

  const applyVisibility = (next: Phase) => {
    const visible = next !== "writing";

    if (visible === !hidden) {
      return;
    }

    host.ui.setWorkingVisible(visible);
    hidden = !visible;
  };

  const begin = () => {
    const timer = setInterval(tick, TICK_MS);
    const key = host.ui.keyText(INTERRUPT_BINDING);

    timer.unref?.();
    phase = "waiting";
    detail = {};
    run = { startedAt: Date.now(), hint: key ? `(${key} to interrupt)` : "", timer };

    write(run);
  };

  const stop = () => {
    if (!run) {
      return;
    }

    clearInterval(run.timer);
    run = undefined;
    written = undefined;
    host.ui.setWorkingMessage(undefined);
  };

  const end = () => {
    detail = {};
    applyVisibility("idle");
    stop();
  };

  host.onSessionStart((info) => {
    place = { cwd: info.cwd, home };
  });

  host.onAgentStart(() => {
    if (host.session().mode !== "tui" || run) {
      return;
    }

    begin();
  });

  host.onPhase((next, nextDetail) => {
    if (next === "idle") {
      end();
      return;
    }

    if (!run) {
      return;
    }

    phase = next;
    detail = nextDetail;
    write(run);
    applyVisibility(next);
  });

  host.onSessionShutdown(() => {
    stop();
  });
};
