import { mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { ContextSnapshot, Host, SessionControl } from "../../../core/adapter/contract.ts";
import { BUSY_CHANNEL, parseBusySignal } from "../../../core/manager/channels.ts";
import { handoffPath, instructionFor, seedText, validateHandoff } from "./handoff.ts";
import {
  contextLevel,
  type HandoffFile,
  handoffStep,
  isPending,
  MAX_INSTRUCTIONS,
  type Phase,
  type Ratios,
  retryInstruction,
  segmentFor,
  shouldRequest,
} from "./thresholds.ts";

export const STATUS_KEY = "pi-session-limits";

export const HANDOFF_COMMAND = "session-handoff";

export const HANDOFF_TYPE = "pi-session-limits-handoff";

type LimitsOptions = {
  host: Host;
  template: string;
  ratios: () => Ratios;
  releaseDelayMs?: number;
};

type LimitsState = {
  phase: Phase;
  instructions: number;
  path?: string;
  staleMtime?: number;
  context?: ContextSnapshot;
  settledSinceInstruction: boolean;
  userActive: boolean;
};

const mtimeOf = (path: string) => {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
};

const readHandoff = (path: string) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const createLimits = ({ host, template, ratios, releaseDelayMs = 1_000 }: LimitsOptions) => {
  const sources = new Set<string>();
  let state: LimitsState = {
    phase: "watching",
    instructions: 0,
    settledSinceInstruction: false,
    userActive: false,
  };
  let turns = 0;
  let switchRunning = false;
  let releaseTimer: ReturnType<typeof setTimeout> | undefined;

  const instruction = (path: string) => instructionFor(template, path);

  const refresh = () => {
    const segment = state.context && segmentFor(state.context, state.phase, ratios(), HANDOFF_COMMAND);

    host.ui.setStatus(STATUS_KEY, segment ? host.ui.style(segment.token, segment.text) : undefined);
  };

  const sendRequest = (path: string) => {
    state = {
      ...state,
      phase: "requested",
      instructions: 1,
      path,
      staleMtime: mtimeOf(path),
      settledSinceInstruction: false,
      userActive: false,
    };

    host.sendUserMessage(instruction(path));
  };

  const request = () => {
    const path = handoffPath(host.session());

    try {
      mkdirSync(dirname(path), { recursive: true });
    } catch (error) {
      state = { ...state, phase: "stuck" };
      host.ui.notify(`Session handoff cannot use ${path}: ${messageOf(error)}.`, "warning");
      return;
    }

    sendRequest(path);
  };

  const inspect = (path: string): HandoffFile => {
    const mtime = mtimeOf(path);

    if (mtime === undefined || mtime === state.staleMtime) {
      return { kind: "missing" };
    }

    const text = readHandoff(path);

    if (text === undefined) {
      return { kind: "missing" };
    }

    const result = validateHandoff(text);

    return result.ok ? { kind: "valid" } : { kind: "invalid", errors: result.errors };
  };

  const errorsOf = (file: HandoffFile, path: string) =>
    file.kind === "invalid" ? file.errors : [`no new handoff file was written to ${path}`];

  const giveUp = (path: string) => {
    state = { ...state, phase: "stuck" };

    host.ui.notify(
      `Session handoff failed: no valid handoff file at ${path} after ${MAX_INSTRUCTIONS} requests. Ask the session to write it, then run /${HANDOFF_COMMAND}.`,
      "warning",
    );
  };

  const resend = (path: string, file: HandoffFile) => {
    state = {
      ...state,
      instructions: state.instructions + 1,
      settledSinceInstruction: false,
      userActive: false,
    };

    host.sendUserMessage(retryInstruction(instruction(path), errorsOf(file, path)));
  };

  const switchSession = () => {
    state = { ...state, phase: "switching" };

    refresh();
    host.dispatchCommand(HANDOFF_COMMAND);
  };

  const check = (settled: boolean) => {
    const path = state.path;

    if (!path) {
      return;
    }

    const file = inspect(path);

    const step = handoffStep({
      phase: state.phase,
      file,
      busy: sources.size > 0,
      settled,
      instructions: state.instructions,
    });

    switch (step) {
      case "wait":
        state = { ...state, phase: "waiting" };
        return;
      case "switch":
        if (!host.isIdle()) {
          return;
        }

        if (state.userActive) {
          sendRequest(path);
          return;
        }

        switchSession();
        return;
      case "resend":
        resend(path, file);
        return;
      case "give-up":
        giveUp(path);
        return;
      case "none":
        return;
    }
  };

  const failSwitch = (message: string) => {
    if (state.phase !== "watching") {
      state = { ...state, phase: "stuck" };
    }

    host.ui.notify(message, "warning");
    refresh();
  };

  const holdSwitch = () => {
    if (state.phase !== "switching") {
      return;
    }

    state = { ...state, phase: "waiting" };

    refresh();

    if (sources.size === 0) {
      release();
    }
  };

  const confirmBusy = async () => {
    if (sources.size === 0) {
      return true;
    }

    const names = Array.from(sources).join(", ");

    return host.ui.confirm(
      "Switch to a new session?",
      `Work reported by ${names} is still running and will be ended by the switch. Switch anyway?`,
    );
  };

  const performSwitch = async (control: SessionControl) => {
    const path = state.path ?? handoffPath(host.session());
    const text = readHandoff(path);

    if (text === undefined) {
      failSwitch(`No session handoff file at ${path}.`);
      return;
    }

    const validation = validateHandoff(text);

    if (!validation.ok) {
      failSwitch(`Session handoff at ${path} is invalid: ${validation.errors.join("; ")}.`);
      return;
    }

    const proceed = await confirmBusy();

    if (!proceed) {
      holdSwitch();
      return;
    }

    const previous = host.session()?.file;

    const accepted = await control
      .newSession({
        parentSession: previous,
        seed: { customType: HANDOFF_TYPE, text: seedText(previous, text) },
      })
      .catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))));

    if (accepted instanceof Error) {
      failSwitch(`Switching to a new session failed: ${accepted.message}. The handoff stays at ${path}.`);
      return;
    }

    if (!accepted) {
      failSwitch(
        `Switching to a new session was cancelled. The handoff stays at ${path}; run /${HANDOFF_COMMAND} to retry.`,
      );
    }
  };

  const runSwitch = async (control: SessionControl) => {
    if (switchRunning) {
      return;
    }

    switchRunning = true;

    try {
      await performSwitch(control);
    } finally {
      switchRunning = false;
    }
  };

  const abandonStalledSwitch = () => {
    if (state.phase === "switching" && !switchRunning) {
      state = { ...state, phase: "stuck" };
    }
  };

  const cancelRelease = () => {
    clearTimeout(releaseTimer);
    releaseTimer = undefined;
  };

  const release = () => {
    const seen = turns;

    cancelRelease();

    releaseTimer = setTimeout(() => {
      releaseTimer = undefined;

      if (state.phase !== "waiting" || turns !== seen || !host.isIdle()) {
        return;
      }

      check(true);
      refresh();
    }, releaseDelayMs);
  };

  host.registerCommand(HANDOFF_COMMAND, {
    description: "Continue in a new session seeded from the session handoff file",
    run: (_args, control) => runSwitch(control),
  });

  host.subscribe(BUSY_CHANNEL, (data) => {
    const signal = parseBusySignal(data);

    if (!signal) {
      return;
    }

    if (signal.busy) {
      sources.add(signal.source);
      cancelRelease();
      return;
    }

    const released = sources.delete(signal.source);

    if (released && sources.size === 0 && state.phase === "waiting") {
      release();
    }
  });

  host.onTurnEnd((context) => {
    turns += 1;

    abandonStalledSwitch();

    if (isPending(state.phase) && state.settledSinceInstruction) {
      state = { ...state, userActive: true };
    }

    const level = contextLevel(context, ratios());

    state = { ...state, context: level === "unknown" ? undefined : context };

    if (shouldRequest(state.phase, level)) {
      request();
    }

    check(false);
    refresh();
  });

  host.onIdle(() => {
    abandonStalledSwitch();

    if (isPending(state.phase)) {
      state = { ...state, settledSinceInstruction: true };
    }

    check(true);
    refresh();
  });

  host.onCompact(() => {
    state = { ...state, context: undefined };
    refresh();
  });

  host.onSessionShutdown(() => {
    cancelRelease();
  });
};
