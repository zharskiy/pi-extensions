export const boundedCache = <K, V>(limit: number) => {
  const entries = new Map<K, Promise<V>>();

  const get = (key: K) => {
    const known = entries.get(key);

    if (known !== undefined) {
      entries.delete(key);

      entries.set(key, known);
    }

    return known;
  };

  const set = (key: K, value: Promise<V>) => {
    entries.delete(key);

    entries.set(key, value);

    value.catch(() => {
      if (entries.get(key) === value) {
        entries.delete(key);
      }
    });

    const excess = [...entries.keys()].slice(0, Math.max(0, entries.size - limit));

    excess.forEach((key) => {
      entries.delete(key);
    });

    return value;
  };

  return { get, set };
};
