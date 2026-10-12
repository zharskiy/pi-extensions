import type { ChildPrompts, HostUi } from "../../../../../core/adapter/contract.ts";
import {
  type AgentRecord,
  type AgentRegistry,
  type Attention,
  type AttentionKind,
  isClosed,
} from "../../model/types.ts";

type PromptQueue = { enqueue<T>(run: () => Promise<T>): Promise<T> };

type PromptDeps = { ui: HostUi; registry: AgentRegistry; queue: PromptQueue };

export const createPromptQueue = (): PromptQueue => {
  let tail: Promise<void> | undefined;

  const enqueue = <T>(run: () => Promise<T>): Promise<T> => {
    const result = tail === undefined ? new Promise<T>((resolve) => resolve(run())) : tail.then(run);

    const settled = result.then(
      () => {},
      () => {},
    );

    tail = settled;

    settled.then(() => {
      if (tail === settled) {
        tail = undefined;
      }
    });

    return result;
  };

  return { enqueue };
};

const promptTitle = (record: Pick<AgentRecord, "id" | "agent">, title: string) =>
  `${record.id} (${record.agent}) asks: ${title}`;

export const childPromptsFor = (deps: PromptDeps, record: AgentRecord): ChildPrompts => {
  let waiting: Attention[] = [];

  const open = () => {
    const current = deps.registry.get(record.id);

    return current !== undefined && !isClosed(current.state);
  };

  const attend = async <T>(
    kind: AttentionKind,
    title: string,
    run: () => Promise<T>,
    denied: T,
  ): Promise<T> => {
    if (!open()) {
      return denied;
    }

    const prompt: Attention = { kind, title, since: Date.now() };

    waiting = [...waiting, prompt];

    if (waiting.length === 1) {
      deps.registry.update(record.id, { attention: prompt });
    }

    try {
      return await deps.queue.enqueue(() => (open() ? run() : Promise.resolve(denied)));
    } finally {
      const head = waiting[0];

      waiting = waiting.filter((entry) => entry !== prompt);

      if (open() && head !== waiting[0]) {
        deps.registry.update(record.id, { attention: waiting[0] });
      }
    }
  };

  return {
    confirm: (title, message) =>
      attend("confirm", title, () => deps.ui.confirm(promptTitle(record, title), message), false),
    select: (title, options) =>
      attend("select", title, () => deps.ui.select(promptTitle(record, title), options), undefined),
    input: (title, placeholder) =>
      attend("input", title, () => deps.ui.input(promptTitle(record, title), placeholder), undefined),
    notify: (message, level) => {
      deps.ui.notify(`${record.id} (${record.agent}): ${message}`, level);
    },
  };
};
