export const singleFlight = <K, V>() => {
  const pending = new Map<K, Promise<V>>();

  return (key: K, start: () => Promise<V>) => {
    const inFlight = pending.get(key);

    if (inFlight !== undefined) {
      return inFlight;
    }

    const started = start().finally(() => pending.delete(key));

    pending.set(key, started);

    return started;
  };
};
