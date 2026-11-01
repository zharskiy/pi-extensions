import { DOT } from "../text/text-layout.ts";

export const seamLabel = (cause: string) => `handed off${DOT}${cause}`;

export const LIMIT_SEAM = seamLabel("context limit");
