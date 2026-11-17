import { LauncherError } from "../../shared/index.ts";
import type { CliDeps } from "../deps.ts";
import { usageOf } from "./help.ts";

type Run = (deps: CliDeps, args: string[]) => Promise<number> | number;

export type Command =
  | { run: Run; options?: string[]; operands?: boolean }
  | { actions: Record<string, Command> };

export const isFlag = (arg: string) => arg.startsWith("-");

export const assertOptions = (command: string, args: string[], known: string[]) => {
  const unknown = args.find((arg) => !known.includes(arg));

  if (unknown !== undefined) {
    throw new LauncherError(`unknown ${command} option "${unknown}"`, usageOf(command));
  }
};
