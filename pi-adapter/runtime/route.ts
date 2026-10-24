import type { RoutedMessage } from "../types/contract.ts";

export const formatRoutedMessage = ({ sender, text }: RoutedMessage) => `[message from ${sender}]\n${text}`;
