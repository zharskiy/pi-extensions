const matchesHostPattern = (pattern: string, host: string) => {
  const lowerPattern = pattern.toLowerCase();
  const lowerHost = host.toLowerCase();

  return lowerPattern.startsWith("*.")
    ? lowerHost.endsWith(lowerPattern.slice(1))
    : lowerPattern === lowerHost;
};

export const matchesAnyHostPattern = (patterns: string[], host: string) =>
  patterns.some((pattern) => matchesHostPattern(pattern, host));
