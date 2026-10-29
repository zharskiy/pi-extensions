import type {
  ContextSnapshot,
  Host,
  SessionControl,
  ThemeToken,
} from "../../../platform/pi-adapter/index.ts";
import {
  BUSY_CHANNEL,
  HANDOFF_REQUEST_TYPE,
  HANDOFF_SEED_TYPE,
  type HandoffRequestDetails,
  type HandoffSeedDetails,
  type HandoffTarget,
  type HandoffValidation,
  handoffInstruction,
  handoffRetry,
  type Limits,
  limitLevel,
  mainLimit,
  parseBusySignal,
  seedText,
} from "../../../platform/shared/index.ts";
import { HANDOFF_COMMAND, handoffPath, MAIN_AUDIENCE, sessionPreface } from "./handoff.ts";
import {
  type ContextTokens,
  handoffStep,
  isPending,
  MAX_INSTRUCTIONS,
  type Phase,
  shouldRequest,
} from "./thresholds.ts";

const NOTICE_KEY = "pi-session-limits";

const AUTOMATIC_REASON = "Your context window is nearly full.";

const IDLE_POLL_MS = 250;

const SAVING_PHASES: readonly Phase[] = ["requested", "waiting", "stuck"];

const MANUAL_REASON = `The user ran /${HANDOFF_COMMAND} to continue in a fresh session.`;

type Segment = { token: ThemeToken; text: string };

type LimitWatchOptions = {
  host: Host;
  limits: () => Limits;
  segment: (
    context: ContextTokens | undefined,
    stuck: boolean,
    limits: Limits,
    command: string,
  ) => Segment | undefined;
  releaseDelayMs?: number;
};

type LimitsState = {
  phase: Phase;
  instructions: number;
  path?: string;
  saved?: { text: string; validation: HandoffValidation };
  context?: ContextSnapshot;
  settledSinceInstruction: boolean;
  userActive: boolean;
  manual: boolean;
  handedOff: boolean;
  focus?: string;
};

type RequestOrigin = { manual: boolean; focus?: string };

export const watchLimits = ({ host, limits, segment, releaseDelayMs = 1_000 }: LimitWatchOptions) => {
  const sources = new Set<string>();
  let state: LimitsState = {
    phase: "watching",
    instructions: 0,
    settledSinceInstruction: false,
    userActive: false,
    manual: false,
    handedOff: false,
  };
  let turns = 0;
  let running = false;
  let switchRunning = false;
  let releaseTimer: ReturnType<typeof setTimeout> | undefined;
  let idlePoll: ReturnType<typeof setTimeout> | undefined;

  const currentInstruction = (path: string) =>
    handoffInstruction({
      path,
      reason: state.handedOff ? MANUAL_REASON : AUTOMATIC_REASON,
      focus: state.focus,
      audience: MAIN_AUDIENCE,
    });

  const requestDetails = (): HandoffRequestDetails => {
    const tokens = state.context?.tokens ?? undefined;
    const request = mainLimit(state.context?.window ?? 0, limits())?.request;

    return state.handedOff
      ? { reason: "manual", command: `/${HANDOFF_COMMAND}` }
      : { reason: "limit", tokens, request };
  };

  const sendInstruction = (text: string) => {
    host.sendMessage({ customType: HANDOFF_REQUEST_TYPE, text, details: requestDetails() });
  };

  const refresh = () => {
    const notice = segment(state.context, state.phase === "stuck", limits(), HANDOFF_COMMAND);

    host.ui.setNotice(NOTICE_KEY, notice ? host.ui.style(notice.token, notice.text) : undefined);
  };

  const sendRequest = (path: string, origin: RequestOrigin) => {
    state = {
      ...state,
      phase: "requested",
      instructions: 1,
      path,
      saved: undefined,
      settledSinceInstruction: false,
      userActive: false,
      manual: origin.manual,
      handedOff: origin.manual,
      focus: origin.focus,
    };

    sendInstruction(currentInstruction(path));
  };

  const request = (origin: RequestOrigin) => {
    sendRequest(handoffPath(host.session()), origin);
  };

  const errorsOf = () => {
    const validation = state.saved?.validation;

    return validation && !validation.ok ? validation.errors : ["no handoff was saved with the handoff tool"];
  };

  const giveUp = () => {
    state = { ...state, phase: "stuck" };

    host.ui.notify(
      `Session handoff failed: no valid handoff after ${MAX_INSTRUCTIONS} requests. Ask the session to call the \`handoff\` tool, then run /${HANDOFF_COMMAND}.`,
      "warning",
    );
  };

  const resend = (path: string) => {
    state = {
      ...state,
      instructions: state.instructions + 1,
      settledSinceInstruction: false,
      userActive: false,
    };

    sendInstruction(handoffRetry(currentInstruction(path), errorsOf()));
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

    const step = handoffStep({
      phase: state.phase,
      saved: state.saved?.validation,
      busy: sources.size > 0 && !state.manual,
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
          sendRequest(path, { manual: state.manual, focus: state.focus });
          return;
        }

        switchSession();
        return;
      case "resend":
        resend(path);
        return;
      case "give-up":
        giveUp();
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

    state = { ...state, phase: "waiting", manual: false };

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
    const { path, saved } = state;

    if (!path || !saved?.validation.ok) {
      failSwitch(
        `No valid handoff was saved; ask the session to call the \`handoff\` tool, then run /${HANDOFF_COMMAND}.`,
      );
      return;
    }

    const proceed = await confirmBusy();

    if (!proceed) {
      holdSwitch();
      return;
    }

    const previous = host.session().file;

    const accepted = await control
      .newSession({
        parentSession: previous,
        keepSelection: true,
        seed: {
          customType: HANDOFF_SEED_TYPE,
          details: { from: "session" } satisfies HandoffSeedDetails,
          text: seedText(
            sessionPreface({
              file: previous,
              manual: state.handedOff,
              focus: state.focus,
            }),
            saved.text,
          ),
        },
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

  const switchNow = (control: SessionControl) => {
    state = { ...state, phase: "switching" };

    refresh();

    return runSwitch(control);
  };

  const queue = (focus: string | undefined) => {
    state = { ...state, phase: "queued", focus };

    host.ui.notify(
      "The session handoff starts when the current turn ends; stopping the turn (esc) cancels it.",
      "info",
    );
  };

  const requestManual = (focus: string | undefined) => {
    if (running || !host.isIdle()) {
      queue(focus);
      return;
    }

    request({ manual: true, focus });
  };

  const handOff = async (args: string, control: SessionControl) => {
    const focus = args.trim() || undefined;

    switch (state.phase) {
      case "watching":
        requestManual(focus);
        break;
      case "queued":
        if (focus) {
          state = { ...state, focus };
          host.ui.notify("Session handoff queued; the focus is updated.", "info");
        } else {
          host.ui.notify("A session handoff is already queued for when the turn ends.", "info");
        }

        break;
      case "requested":
        host.ui.notify(
          "A session handoff is already being written; the session switches when it is ready.",
          "info",
        );
        return;
      case "switching":
        await runSwitch(control);
        return;
      case "waiting":
        if (!focus) {
          await runSwitch(control);
          return;
        }

        requestManual(focus);
        break;
      case "stuck":
        if (!focus && state.saved?.validation.ok) {
          await switchNow(control);
          return;
        }

        requestManual(focus);
        break;
    }

    refresh();
  };

  host.registerCommand(HANDOFF_COMMAND, {
    description:
      "Continue in a fresh session: the model writes a handoff now, then pi switches to a new session started from it. Optional: what the next session is for",
    run: handOff,
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

    const level = limitLevel(context.tokens, mainLimit(context.window, limits()));

    state = { ...state, context: level === "unknown" ? undefined : context };

    if (shouldRequest(state.phase, level)) {
      request({ manual: false });
    }

    check(false);
    refresh();
  });

  const cancelManual = () => {
    state = {
      ...state,
      phase: "watching",
      instructions: 0,
      path: undefined,
      saved: undefined,
      settledSinceInstruction: false,
      userActive: false,
      manual: false,
      handedOff: false,
      focus: undefined,
    };

    host.ui.notify("Session handoff cancelled.", "info");
    refresh();
  };

  const stopIdlePoll = () => {
    clearTimeout(idlePoll);
    idlePoll = undefined;
  };

  const releaseQueued = () => {
    stopIdlePoll();

    if (state.phase !== "queued" || running) {
      return;
    }

    if (!host.isIdle()) {
      idlePoll = setTimeout(releaseQueued, IDLE_POLL_MS);
      return;
    }

    request({ manual: true, focus: state.focus });
    refresh();
  };

  host.onAgentStart(() => {
    running = true;
    stopIdlePoll();
  });

  host.onIdle((info) => {
    running = false;
    stopIdlePoll();

    abandonStalledSwitch();

    if (state.phase === "queued") {
      if (info.aborted) {
        cancelManual();
        return;
      }

      request({ manual: true, focus: state.focus });
      refresh();
      return;
    }

    if (info.aborted && state.phase === "requested" && state.handedOff) {
      cancelManual();
      return;
    }

    if (isPending(state.phase)) {
      state = { ...state, settledSinceInstruction: true };
    }

    check(true);
    refresh();
  });

  host.onCompact(() => {
    state = { ...state, context: undefined };
    refresh();
    releaseQueued();
  });

  host.onSessionShutdown(() => {
    cancelRelease();
    stopIdlePoll();
  });

  const target = (): HandoffTarget | undefined =>
    state.path ? { path: state.path, requested: SAVING_PHASES.includes(state.phase) } : undefined;

  const saved = (text: string, validation: HandoffValidation) => {
    state = { ...state, saved: { text, validation } };

    check(false);
    refresh();
  };

  return { target, saved };
};
