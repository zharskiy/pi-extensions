export const ALIASES = new Map([
  ["/continue", "/resume"],
  ["/clear", "/new"],
  ["/exit", "/quit"],
]);

export const targetOf = (text: string) => ALIASES.get(text.trim());
