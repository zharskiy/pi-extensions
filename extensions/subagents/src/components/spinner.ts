export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export const spinnerFrame = (now: number): string =>
  SPINNER_FRAMES[Math.floor(now / 100) % SPINNER_FRAMES.length];
