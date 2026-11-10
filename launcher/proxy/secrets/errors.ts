export interface SecretReply {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export class SecretUnavailable extends Error {
  readonly reply?: SecretReply;

  readonly hostSignIn: boolean;

  constructor(reason: string, reply?: SecretReply, hostSignIn = reply !== undefined) {
    super(reason);
    this.name = "SecretUnavailable";
    this.reply = reply;
    this.hostSignIn = hostSignIn;
  }
}

export const unavailable = (reason: string) => new SecretUnavailable(reason);

export const signInReply = (reason: string, reply: SecretReply) => new SecretUnavailable(reason, reply);

export const notSignedIn = (reason: string) => new SecretUnavailable(reason, undefined, true);
