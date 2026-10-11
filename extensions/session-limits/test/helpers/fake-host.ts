import type {
  CommandSpec,
  ContextSnapshot,
  Host,
  NewSessionOptions,
  SessionInfo,
} from "../../src/adapter/contract.ts";

export type FakeHost = Host & {
  info: SessionInfo;
  idle: boolean;
  sent: string[];
  dispatched: string[];
  notices: { message: string; level: string }[];
  statuses: Map<string, string | undefined>;
  confirmations: { title: string; message: string }[];
  confirmAnswer: boolean;
  newSessions: NewSessionOptions[];
  newSessionResult: boolean | Error;
  commands: Map<string, CommandSpec>;
  start(): void;
  turnEnd(context: ContextSnapshot): void;
  settle(): void;
  shutdown(): void;
  emit(channel: string, data: unknown): void;
  runCommand(name: string): Promise<void>;
};

export const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

export const createFakeHost = (info: SessionInfo): FakeHost => {
  const startHandlers: ((info: SessionInfo) => void)[] = [];
  const turnHandlers: ((context: ContextSnapshot) => void)[] = [];
  const idleHandlers: (() => void)[] = [];
  const shutdownHandlers: (() => void)[] = [];
  const deferred: string[] = [];
  const eventHandlers = new Map<string, ((data: unknown) => void)[]>();
  let started = false;
  let settling = false;

  const host: FakeHost = {
    info,
    idle: true,
    sent: [],
    dispatched: [],
    notices: [],
    statuses: new Map(),
    confirmations: [],
    confirmAnswer: true,
    newSessions: [],
    newSessionResult: true,
    commands: new Map(),
    notify: (message, level) => {
      host.notices.push({ message, level });
    },
    style: (token, text) => `<${token}>${text}`,
    setStatus: (key, text) => {
      host.statuses.set(key, text);
    },
    confirm: async (title, message) => {
      host.confirmations.push({ title, message });

      return host.confirmAnswer;
    },
    registerCommand: (name, spec) => {
      host.commands.set(name, spec);
    },
    onSessionStart: (handler) => {
      startHandlers.push(handler);
    },
    onTurnEnd: (handler) => {
      turnHandlers.push(handler);
    },
    onIdle: (handler) => {
      idleHandlers.push(handler);
    },
    onShutdown: (handler) => {
      shutdownHandlers.push(handler);
    },
    onEvent: (channel, handler) => {
      eventHandlers.set(channel, [...(eventHandlers.get(channel) ?? []), handler]);
    },
    isIdle: () => started && host.idle,
    session: () => (started ? host.info : undefined),
    sendUserMessage: (text) => {
      host.sent.push(text);
    },
    dispatchCommand: (name) => {
      host.dispatched.push(name);

      if (settling) {
        deferred.push(name);
        return;
      }

      void host.runCommand(name);
    },
    start: () => {
      started = true;

      startHandlers.forEach((handler) => {
        handler(host.info);
      });
    },
    turnEnd: (context) => {
      host.idle = false;

      turnHandlers.forEach((handler) => {
        handler(context);
      });
    },
    settle: () => {
      host.idle = true;
      settling = true;

      idleHandlers.forEach((handler) => {
        handler();
      });

      settling = false;

      deferred.splice(0).forEach((name) => {
        void host.runCommand(name);
      });
    },
    shutdown: () => {
      shutdownHandlers.forEach((handler) => {
        handler();
      });

      started = false;
    },
    emit: (channel, data) => {
      eventHandlers.get(channel)?.forEach((handler) => {
        handler(data);
      });
    },
    runCommand: async (name) => {
      const spec = host.commands.get(name);

      if (!spec) {
        throw new Error(`command ${name} not registered`);
      }

      await spec.run({
        newSession: async (options) => {
          host.newSessions.push(options);

          if (host.newSessionResult instanceof Error) {
            throw host.newSessionResult;
          }

          return host.newSessionResult;
        },
      });
    },
  };

  return host;
};
