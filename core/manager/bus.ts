export type EventMap = Record<string, unknown>;

type Listener<E extends EventMap, K extends keyof E> = (payload: E[K]) => void;

export type Bus<E extends EventMap> = {
  on<K extends keyof E>(event: K, listener: Listener<E, K>): () => void;
  emit<K extends keyof E>(event: K, payload: E[K]): void;
};

export const createBus = <E extends EventMap>(onError: (error: unknown) => void = () => {}): Bus<E> => {
  const listeners = new Map<keyof E, Set<Listener<E, keyof E>>>();

  const on = <K extends keyof E>(event: K, listener: Listener<E, K>) => {
    const set = listeners.get(event) ?? new Set();

    set.add(listener as Listener<E, keyof E>);
    listeners.set(event, set);

    return () => {
      set.delete(listener as Listener<E, keyof E>);
    };
  };

  const emit = <K extends keyof E>(event: K, payload: E[K]) => {
    const set = listeners.get(event);

    if (!set) {
      return;
    }

    Array.from(set).forEach((listener) => {
      try {
        listener(payload);
      } catch (error) {
        onError(error);
      }
    });
  };

  return { on, emit };
};
