export const fillTemplate = (template: string, values: Record<string, string>) =>
  template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => values[key] ?? match);
