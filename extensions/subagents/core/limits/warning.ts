export const softWarning = (tokens: number, limit: number) =>
  `Context limit warning: about ${Math.round((tokens / limit) * 100)}% of your ${limit}-token context limit is used. Finish the current step, avoid reading large files, and prepare to wrap up.`;
