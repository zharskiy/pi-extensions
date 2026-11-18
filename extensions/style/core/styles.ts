import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseFrontmatter } from "../../../platform/shared/index.ts";

export type Style = { prompt: string; description?: string };

export const NORMAL = "normal";

export const DEFAULT_STYLE = "concise";

export const NORMAL_DESCRIPTION = "no style, pi's default replies";

export const parseStyle = (text: string): Style => {
  const { data, body } = parseFrontmatter(text);
  const description = typeof data.description === "string" ? data.description.trim() : "";

  return { prompt: body, description: description || undefined };
};

export const loadStyles = (dir: string): ReadonlyMap<string, Style> =>
  new Map(
    readdirSync(dir)
      .filter((file) => file.endsWith(".md") && file !== `${NORMAL}.md`)
      .sort()
      .map((file) => [basename(file, ".md"), parseStyle(readFileSync(join(dir, file), "utf8"))]),
  );
