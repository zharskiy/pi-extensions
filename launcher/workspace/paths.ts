import { sep } from "node:path";

const depthOf = (path: string) => path.split(sep).length;

const byCodeUnit = (first: string, second: string) => (first < second ? -1 : first > second ? 1 : 0);

export const byDepth = (first: string, second: string) =>
  depthOf(first) - depthOf(second) || byCodeUnit(first, second);
