export class LauncherError extends Error {
  readonly hint?: string;
  readonly exitCode?: number;

  constructor(message: string, hint?: string, exitCode?: number) {
    super(message);
    this.name = "LauncherError";
    this.hint = hint;
    this.exitCode = exitCode;
  }
}

export const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));
