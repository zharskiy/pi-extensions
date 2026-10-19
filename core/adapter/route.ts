import type { RoutedMessage } from "./contract.ts";

export const formatRoutedMessage = ({ sender, text }: RoutedMessage) => `[message from ${sender}]\n${text}`;
