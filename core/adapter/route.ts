import type { RoutedMessage } from "./contract.ts";

export const formatRoutedMessage = (message: RoutedMessage) =>
  `[message from ${message.sender}]\n${message.text}`;

const ROUTED_HEADER = /^\[message from ([^\]\n]+)\]\n/;

export const parseRoutedMessage = (text: string): RoutedMessage | undefined => {
  const match = ROUTED_HEADER.exec(text);

  if (!match?.[1]) {
    return undefined;
  }

  return { sender: match[1], text: text.slice(match[0].length) };
};
