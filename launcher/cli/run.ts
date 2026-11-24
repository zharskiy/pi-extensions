import { errorMessage, LauncherError } from "../shared/index.ts";
import { type CliDeps, writeLine } from "./deps.ts";
import { intercept } from "./intercept.ts";
import { launch } from "./launch.ts";

const UNEXPECTED_EXIT = 70;

const route = async (argv: string[], deps: CliDeps) => {
  const intercepted = argv.includes("--no-sandbox") ? undefined : await intercept(argv, deps);

  return intercepted ?? launch(argv, deps);
};

export const renderFailure = (error: unknown, stderr: NodeJS.WritableStream) => {
  if (error instanceof LauncherError) {
    writeLine(stderr, `pinata: ${error.message}`);

    if (error.hint !== undefined) {
      writeLine(stderr, `  hint: ${error.hint}`);
    }

    return 1;
  }

  writeLine(stderr, `pinata: unexpected error: ${errorMessage(error)}`);

  return UNEXPECTED_EXIT;
};

export const run = async (argv: string[], deps: CliDeps) => {
  try {
    return await route(argv, deps);
  } catch (error) {
    return renderFailure(error, deps.stderr);
  }
};
