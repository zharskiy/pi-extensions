export interface SecretReply {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export class SecretUnavailable extends Error {
  readonly reply?: SecretReply;

  constructor(reason: string, reply?: SecretReply) {
    super(reason);
    this.name = "SecretUnavailable";
    this.reply = reply;
  }
}

export const unavailable = (reason: string) => new SecretUnavailable(reason);

export const signInReply = (reason: string, reply: SecretReply) => new SecretUnavailable(reason, reply);
