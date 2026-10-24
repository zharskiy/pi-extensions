const SOURCES = ["claude", "cursor"] as const;

export type Source = (typeof SOURCES)[number];

export type Scope = "user" | "project";

export type ImportArgs = { source: Source; scope: Scope; apply: boolean };

const FLAGS = ["project", "apply"];

export const USAGE = "/mcp-import <claude|cursor> [project] [apply]";

const isSource = (word: string): word is Source => (SOURCES as readonly string[]).includes(word);

export const MISSING_SOURCE = `name the tool to import from; usage: ${USAGE}`;

export const parseArgs = (text: string): ImportArgs | { error: string } | { interactive: true } => {
  const [first, ...rest] = text.trim().split(/\s+/).filter(Boolean);

  if (!first) {
    return { interactive: true };
  }

  if (!isSource(first)) {
    return { error: `unknown tool "${first}" (available: ${SOURCES.join(", ")}); usage: ${USAGE}` };
  }

  const unknownWords = rest.filter((word) => !FLAGS.includes(word));

  if (unknownWords.length > 0) {
    return {
      error: `unknown argument ${unknownWords.map((word) => `"${word}"`).join(", ")}; usage: ${USAGE}`,
    };
  }

  return {
    source: first,
    scope: rest.includes("project") ? "project" : "user",
    apply: rest.includes("apply"),
  };
};

export const completeArgs = (prefix: string) => {
  const words = prefix.trimStart().split(/\s+/);
  const last = words.pop() ?? "";
  const head = words.length > 0 ? `${words.join(" ")} ` : "";
  const options: string[] = words.length === 0 ? [...SOURCES] : FLAGS.filter((flag) => !words.includes(flag));
  const matches = options.filter((option) => option.startsWith(last));

  return matches.length > 0 ? matches.map((option) => ({ value: `${head}${option}`, label: option })) : null;
};
