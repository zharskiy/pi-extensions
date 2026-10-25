import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

export type Style = { prompt: string; description?: string };

export const NORMAL = "normal";

export const DEFAULT_STYLE = "concise";

export const NORMAL_DESCRIPTION = "no style, pi's default replies";

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---[^\S\r\n]*(?:\r?\n|$)/;

export const parseStyle = (text: string): Style => {
  const header = FRONT_MATTER.exec(text);
  const description = header?.[1]?.match(/^description:(.*)$/m)?.[1]?.trim();

  return {
    prompt: text.slice(header?.[0].length ?? 0).trim(),
    description: description || undefined,
  };
};

export const loadStyles = (dir: string): ReadonlyMap<string, Style> =>
  new Map(
    readdirSync(dir)
      .filter((file) => file.endsWith(".md") && file !== `${NORMAL}.md`)
      .sort()
      .map((file) => [basename(file, ".md"), parseStyle(readFileSync(join(dir, file), "utf8"))]),
  );
