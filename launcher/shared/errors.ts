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

export const errnoCode = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;

export const isMissing = (error: unknown) => errnoCode(error) === "ENOENT";
