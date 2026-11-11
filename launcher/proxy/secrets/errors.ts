export interface SecretReply {
  status: number;
  headers: Record<string, string>;
  body: string;
}

interface UnavailableOptions {
  reply?: SecretReply;
  hostSignIn?: boolean;
  login?: boolean;
}

export class SecretUnavailable extends Error {
  readonly reply?: SecretReply;

  readonly hostSignIn: boolean;

  readonly login: boolean;

  constructor(reason: string, options: UnavailableOptions = {}) {
    super(reason);
    this.name = "SecretUnavailable";
    this.reply = options.reply;
    this.hostSignIn = options.hostSignIn ?? options.reply !== undefined;
    this.login = options.login ?? false;
  }
}

export const unavailable = (reason: string) => new SecretUnavailable(reason);

export const signInReply = (reason: string, reply: SecretReply) => new SecretUnavailable(reason, { reply });

export const notSignedIn = (reason: string) => new SecretUnavailable(reason, { hostSignIn: true });

export const loginMissing = (provider: string) =>
  new SecretUnavailable(`the ${provider} login on the host is missing or expired`, { login: true });
