import { transcriptRows } from "../../src/tools.ts";

export const rows = transcriptRows(() => "ctrl+o", "/home/me");

export const numbered = (count: number, word = "out") =>
  Array.from({ length: count }, (_value, index) => `${word} ${index + 1}`).join("\n");
