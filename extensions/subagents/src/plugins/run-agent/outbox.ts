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
    if (held.length > 0) {
      channel.deliver(held.splice(0).join("\n\n---\n\n"));
    }
  };

  channel.onIdle(flush);

  return {
    post: (text) => {
      held.push(text);

      if (!channel.isBusy()) {
        flush();
      }
    },
    pending: () => held.length,
    clear: () => held.splice(0),
  };
};
