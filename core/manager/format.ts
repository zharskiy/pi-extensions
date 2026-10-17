import { sep } from "node:path";

export const formatTokens = (n: number): string => {
  if (n < 1_000) {
    return `${n}`;
  }

  const thousands = (n / 1_000).toFixed(1);

  if (Number(thousands) < 1_000) {
    return `${thousands}k`;
  }

  return `${(n / 1_000_000).toFixed(1)}M`;
};

export const formatWindow = (count: number): string => {
  if (count >= 1_000_000) {
    const millions = count / 1_000_000;

    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
  }

  return count >= 1_000 ? `${Math.round(count / 1_000)}k` : `${count}`;
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

export const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const homeRelative = (path: string, home: string): string =>
  home && (path === home || path.startsWith(`${home}${sep}`)) ? `~${path.slice(home.length)}` : path;
