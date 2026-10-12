type CallerChannel = {
  isBusy(): boolean;
  deliver(text: string): void;
  onIdle(handler: () => void): void;
};

export type Outbox = {
  post(text: string): void;
  pending(): number;
  clear(): string[];
};

export const createOutbox = (channel: CallerChannel): Outbox => {
  const held: string[] = [];

  const flush = () => {
    if (held.length === 0) {
      return;
    }

    const text = held.splice(0).join("\n\n---\n\n");

    channel.deliver(text);
  };

  channel.onIdle(flush);

  const post = (text: string) => {
    held.push(text);

    if (channel.isBusy()) {
      return;
    }

    flush();
  };

  return {
    post,
    pending: () => held.length,
    clear: () => held.splice(0),
  };
};
