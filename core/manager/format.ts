export const formatTokens = (n: number): string => {
  if (n < 1_000) {
    return `${n}`;
  }

  if (n < 1_000_000) {
    return `${(n / 1_000).toFixed(1)}k`;
  }

  return `${(n / 1_000_000).toFixed(1)}M`;
};

export const formatDuration = (ms: number): string => {
  const seconds = Math.max(0, Math.floor(ms / 1_000));

  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);

  if (minutes < 60) {
    return `${minutes}m ${seconds % 60}s`;
  }

  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};
