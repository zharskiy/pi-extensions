export type OutboxItem = { batchId: string; text: string };

type CallerChannel = {
  isBusy(): boolean;
  deliver(items: OutboxItem[]): void;
  onIdle(handler: () => void): void;
};

export type Outbox = {
  post(item: OutboxItem): void;
  pending(): number;
  clear(): OutboxItem[];
};

export const joinTexts = (items: OutboxItem[]) => items.map((item) => item.text).join("\n\n---\n\n");

export const createOutbox = (channel: CallerChannel): Outbox => {
  const held: OutboxItem[] = [];

  const flush = () => {
    if (held.length > 0) {
      channel.deliver(held.splice(0));
    }
  };

  channel.onIdle(flush);

  return {
    post: (item) => {
      held.push(item);

      if (!channel.isBusy()) {
        flush();
      }
    },
    pending: () => held.length,
    clear: () => held.splice(0),
  };
};
