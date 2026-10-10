import type { RoutedMessage } from "./contract.ts";

export const formatRoutedMessage = (message: RoutedMessage) =>
  `[message from ${message.sender}]\n${message.text}`;
