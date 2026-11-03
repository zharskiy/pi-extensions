export class LauncherError extends Error {
  readonly hint?: string;

  constructor(message: string, hint?: string) {
    super(message);
    this.name = "LauncherError";
    this.hint = hint;
  }
}

export const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));
