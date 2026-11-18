import type { HostTerminal } from "../container/index.ts";
import { DEFAULT_COLUMNS, DEFAULT_ROWS } from "./prompt/terminal.ts";

export const hostTerminal = (): HostTerminal => ({
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  get columns() {
    return process.stdout.columns || DEFAULT_COLUMNS;
  },
  get rows() {
    return process.stdout.rows || DEFAULT_ROWS;
  },
  onResize: (listener) => {
    const notify = () =>
      listener({
        columns: process.stdout.columns || DEFAULT_COLUMNS,
        rows: process.stdout.rows || DEFAULT_ROWS,
      });

    process.stdout.on("resize", notify);

    return () => {
      process.stdout.off("resize", notify);
    };
  },
});
