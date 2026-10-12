export const UNKNOWN_LIMIT = 0;

export const effectiveContextLimit = (limit: number, window: number, reserveTokens: number) => {
  if (window <= 0 || limit <= UNKNOWN_LIMIT) {
    return limit;
  }

  return Math.max(1, Math.min(limit, window - reserveTokens));
};
