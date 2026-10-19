import type { RoutedMessage } from "./contract.ts";

const ROUTED_PREFIX = "[message from ";
const ROUTED_END = "]\n";

export const formatRoutedMessage = ({ sender, text }: RoutedMessage) =>
  `${ROUTED_PREFIX}${sender}${ROUTED_END}${text}`;

export const parseRoutedMessage = (text: string): RoutedMessage | undefined => {
  if (!text.startsWith(ROUTED_PREFIX)) {
    return undefined;
  }

  const end = text.indexOf(ROUTED_END, ROUTED_PREFIX.length);
  const sender = end === -1 ? "" : text.slice(ROUTED_PREFIX.length, end);

  if (!sender || sender.includes("\n")) {
    return undefined;
  }

  return { sender, text: text.slice(end + ROUTED_END.length) };
};
