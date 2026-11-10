import { afterEach, describe, expect, it } from "vitest";
import { hostTerminal } from "../../cli/terminal.ts";

const original = { columns: process.stdout.columns, rows: process.stdout.rows };

afterEach(() => {
  process.stdout.columns = original.columns;
  process.stdout.rows = original.rows;
});

describe("the host terminal", () => {
  it("reads the terminal size when it is used, not when the launcher starts", () => {
    process.stdout.columns = 100;
    process.stdout.rows = 30;

    const terminal = hostTerminal();

    process.stdout.columns = 132;
    process.stdout.rows = 50;

    expect({ columns: terminal.columns, rows: terminal.rows }).toEqual({ columns: 132, rows: 50 });
  });
});
