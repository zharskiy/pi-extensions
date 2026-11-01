import type { CustomMessage } from "../../../../platform/pi-adapter/index.ts";
import { NAMESPACE } from "../model/paths.ts";

type CallerChannel = {
  isBusy(): boolean;
  deliver(texts: string[]): void;
  onIdle(handler: () => void): void;
};

export type Outbox = {
  post(text: string): void;
  pending(): number;
  clear(): string[];
};

export const joinTexts = (texts: string[]) => texts.join("\n\n---\n\n");

export const wakeMessage = (texts: string[]): CustomMessage => ({
  customType: `${NAMESPACE}:wake`,
  text: joinTexts(texts),
});

export const createOutbox = (channel: CallerChannel): Outbox => {
  const held: string[] = [];

  const flush = () => {
    if (held.length > 0) {
      channel.deliver(held.splice(0));
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
