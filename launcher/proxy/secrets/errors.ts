export class SecretUnavailable extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "SecretUnavailable";
  }
}

export const unavailable = (reason: string) => new SecretUnavailable(reason);
