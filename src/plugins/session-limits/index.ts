import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ContextSnapshot } from "../../adapter/contract.ts";
import type { Plugin } from "../../manager/plugin.ts";
import { isClosed, MAIN_CALLER } from "../../manager/types.ts";
import { mainHandoffPath, seedText } from "./seed.ts";
import {
  contextLevel,
  type HandoffFile,
  handoffStep,
  MAX_INSTRUCTIONS,
  type Phase,
  retryInstruction,
  segmentFor,
  shouldRequest,
} from "./thresholds.ts";

export const CONTEXT_STATUS_KEY = "pi-subagents-context";

export const HANDOFF_COMMAND = "subagents-handoff";

export const MAIN_HANDOFF_TYPE = "pi-subagents-main-handoff";

type LimitsState = {
  phase: Phase;
  instructions: number;
  path?: string;
  staleMtime?: number;
  context?: ContextSnapshot;
  settledSinceInstruction: boolean;
  userActive: boolean;
};

const initialState = (): LimitsState => ({
  phase: "watching",
  instructions: 0,
  settledSinceInstruction: false,
  userActive: false,
});

const isPending = (phase: Phase) => phase === "requested" || phase === "waiting";

const mtimeOf = (path: string) => (existsSync(path) ? statSync(path).mtimeMs : undefined);

export const sessionLimitsPlugin: Plugin = {
  id: "session-limits",
  requires: ["agent-registry", "handoff"],
  enable: ({ host, settings, services, packageRoot }) => {
    const registry = services.require("registry");
    const handoff = services.require("handoff");
    const template = readFileSync(join(packageRoot, "prompts", "main-handoff.md"), "utf8");
    let state = initialState();

    const ratios = () => ({ softRatio: settings.mainSoftRatio, hardRatio: settings.mainHardRatio });

    const instruction = (path: string) => template.replaceAll("{{path}}", path).trim();

    const openAgents = () => registry.list().filter((record) => !isClosed(record.state));

    const refresh = () => {
      if (!state.context) {
        return;
      }

      const segment = segmentFor(state.context, state.phase, ratios());

      host.ui.setStatus(CONTEXT_STATUS_KEY, segment ? host.ui.style(segment.token, segment.text) : undefined);
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
      const path = mainHandoffPath(host.session());

      mkdirSync(dirname(path), { recursive: true });

      sendRequest(path);
    };

    const inspect = (path: string): HandoffFile => {
      const mtime = mtimeOf(path);

      if (mtime === undefined || mtime === state.staleMtime) {
        return { kind: "missing" };
      }

      const result = handoff.validate(readFileSync(path, "utf8"));

      return result.ok ? { kind: "valid" } : { kind: "invalid", errors: result.errors };
    };

    const errorsOf = (file: HandoffFile, path: string) =>
      file.kind === "invalid" ? file.errors : [`no new handoff file was written to ${path}`];

    const giveUp = (path: string) => {
      state = { ...state, phase: "stuck" };

      host.ui.notify(
        `Main session handoff failed: no valid handoff file at ${path} after ${MAX_INSTRUCTIONS} requests. Ask the session to write it, then run /${HANDOFF_COMMAND}.`,
        "warning",
      );
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
        openAgents: openAgents().length,
        settled,
        instructions: state.instructions,
      });

      if (step === "wait") {
        state = { ...state, phase: "waiting" };
      }

      if (step === "switch" && host.isIdle() && state.userActive) {
        sendRequest(path);
        return;
      }

      if (step === "switch" && host.isIdle()) {
        state = { ...state, phase: "switching" };

        refresh();
        host.dispatchCommand(HANDOFF_COMMAND);
        return;
      }

      if (step === "resend") {
        state = {
          ...state,
          instructions: state.instructions + 1,
          settledSinceInstruction: false,
          userActive: false,
        };

        host.sendUserMessage(retryInstruction(instruction(path), errorsOf(file, path)));
      }

      if (step === "give-up") {
        giveUp(path);
      }
    };

    const failSwitch = (message: string) => {
      if (state.phase !== "watching") {
        state = { ...state, phase: "stuck" };
      }

      host.ui.notify(message, "warning");
      refresh();
    };

    const lateAgents = (path: string) => {
      const written = mtimeOf(path) ?? 0;

      return registry
        .list()
        .filter(
          (record) =>
            record.callerId === MAIN_CALLER && !record.successorId && (record.endedAt ?? 0) > written,
        );
    };

    host.registerCommand(HANDOFF_COMMAND, {
      description: "Continue in a new session seeded from the main session handoff file",
      run: async (_args, control) => {
        const path = state.path ?? mainHandoffPath(host.session());

        if (!existsSync(path)) {
          failSwitch(`No main session handoff file at ${path}.`);
          return;
        }

        const text = readFileSync(path, "utf8");
        const validation = handoff.validate(text);

        if (!validation.ok) {
          failSwitch(`Main session handoff at ${path} is invalid: ${validation.errors.join("; ")}.`);
          return;
        }

        const open = openAgents();

        if (open.length > 0) {
          const proceed = await host.ui.confirm(
            "Switch to a new session?",
            `${open.length} agent(s) still running will be closed as failed.`,
          );

          if (!proceed) {
            return;
          }
        }

        const previous = host.session()?.file;

        const accepted = await control
          .newSession({
            parentSession: previous,
            seed: { customType: MAIN_HANDOFF_TYPE, text: seedText(previous, text, lateAgents(path)) },
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
      },
    });

    host.onTurnEnd((context) => {
      if (isPending(state.phase) && state.settledSinceInstruction) {
        state = { ...state, userActive: true };
      }

      const level = contextLevel(context, ratios());

      if (level !== "unknown") {
        state = { ...state, context };
      }

      if (shouldRequest(state.phase, level)) {
        request();
      }

      check(false);
      refresh();
    });

    host.onIdle(() => {
      if (isPending(state.phase)) {
        state = { ...state, settledSinceInstruction: true };
      }

      check(true);
      refresh();
    });

    host.onSessionStart(() => {
      state = initialState();

      host.ui.setStatus(CONTEXT_STATUS_KEY, undefined);
    });

    return undefined;
  },
};
