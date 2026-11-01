import { CHILD_COLUMN, type MessageRender, type ThemeLike } from "../../../../platform/pi-adapter/index.ts";
import { DOT } from "../../../../platform/shared/index.ts";
import {
  EXPAND_BINDING,
  expandHint,
  firstSentence,
  row,
  wrapChild,
} from "../../../../platform/ui-kit/index.ts";
import {
  type BatchSummary,
  NOTICE_SENDER,
  parseBatchDetails,
  parseRoutedDetails,
  routedBody,
} from "../../core/model/child-messages.ts";

type KeyText = (binding: string) => string;

const wrapped = (text: string, width: number, theme: ThemeLike) =>
  wrapChild(text.trim(), width, CHILD_COLUMN, theme).join("\n");

const batchTitle = (batches: BatchSummary[]) =>
  batches.length > 0
    ? batches.map(({ id, counts }) => `batch ${id} finished${DOT}${counts}`).join(", ")
    : "batch results";

export const batchResultMessage =
  (keyText: KeyText): MessageRender =>
  (message, width, expanded, theme) =>
    row({
      mark: "info",
      title: theme.bold(batchTitle(parseBatchDetails(message.details).batches)),
      children: expanded ? [wrapped(message.text, width, theme)] : [],
      hint: expanded ? undefined : expandHint(keyText(EXPAND_BINDING)),
      hintCuts: true,
    })(width, theme);

const noticeRow = (text: string, width: number, expanded: boolean, theme: ThemeLike, key: string) =>
  row({
    mark: "info",
    title: theme.fg("dim", firstSentence(text)),
    children: expanded ? [wrapped(text, width, theme)] : [],
    hint: expanded ? undefined : expandHint(key),
    hintCuts: true,
  })(width, theme);

export const routedMessageRow =
  (keyText: KeyText): MessageRender =>
  (message, width, expanded, theme) => {
    const sender = parseRoutedDetails(message.details)?.sender ?? "";
    const body = routedBody(message.text, sender);

    if (sender === NOTICE_SENDER) {
      return noticeRow(body, width, expanded, theme, keyText(EXPAND_BINDING));
    }

    return row({
      mark: "info",
      title: theme.bold(`message from ${sender}`),
      children: [wrapped(body, width, theme)],
    })(width, theme);
  };
