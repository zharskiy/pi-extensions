import {
  type CustomMessage,
  formatRoutedMessage,
  type RoutedMessage,
} from "../../../../platform/pi-adapter/index.ts";
import { isPlainObject } from "../../../../platform/shared/index.ts";
import { NAMESPACE } from "./paths.ts";

export const ROUTED_TYPE = `${NAMESPACE}:message`;

export const BATCH_TYPE = `${NAMESPACE}:batch`;

export const NOTICE_SENDER = NAMESPACE;

export type RoutedDetails = { sender: string };

export type BatchSummary = { id: string; counts: string };

export type BatchDetails = { batches: BatchSummary[] };

export const routedMessage = (message: RoutedMessage): CustomMessage => ({
  customType: ROUTED_TYPE,
  text: formatRoutedMessage(message),
  details: { sender: message.sender } satisfies RoutedDetails,
});

export const parseRoutedDetails = (details: unknown): RoutedDetails | undefined =>
  isPlainObject(details) && typeof details.sender === "string" ? { sender: details.sender } : undefined;

const isSummary = (value: unknown): value is BatchSummary =>
  isPlainObject(value) && typeof value.id === "string" && typeof value.counts === "string";

export const parseBatchDetails = (details: unknown): BatchDetails =>
  isPlainObject(details) && Array.isArray(details.batches)
    ? { batches: details.batches.filter(isSummary) }
    : { batches: [] };

export const routedBody = (text: string, sender: string) => {
  const header = formatRoutedMessage({ sender, text: "" });

  return text.startsWith(header) ? text.slice(header.length) : text;
};
