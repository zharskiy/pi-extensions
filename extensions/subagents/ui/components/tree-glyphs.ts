import { MARKS } from "../../../../ui-kit/index.ts";
import type { TreeRow } from "../../core/components/tree.ts";

export const nestPrefix = (row: Pick<TreeRow, "depth" | "first">): string =>
  row.depth === 0 ? "" : `${"  ".repeat(row.depth - 1)}${row.first ? `${MARKS.child} ` : "  "}`;
