import { LauncherError } from "../../shared/index.ts";
import { usageOf } from "./help.ts";

export const assertOptions = (command: string, args: string[], known: string[]) => {
  const unknown = args.find((arg) => !known.includes(arg));

  if (unknown !== undefined) {
    throw new LauncherError(`unknown ${command} option "${unknown}"`, usageOf(command));
  }
};
