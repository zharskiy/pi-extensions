import type { FakeChildSession } from "../../../../test/framework/index.ts";
import { BATCH_TYPE, parseRoutedDetails, ROUTED_TYPE, routedBody } from "../../core/model/child-messages.ts";

type Sent = FakeChildSession["messages"][number];

const ofType = (customType: string) => (entry: Sent) =>
  "customType" in entry.message && entry.message.customType === customType;

export const wakesOf = (child: FakeChildSession) =>
  child.messages.filter(ofType(BATCH_TYPE)).map((entry) => entry.message.text);

export const routedOf = (child: FakeChildSession) =>
  child.messages.filter(ofType(ROUTED_TYPE)).map(({ message, delivery }) => {
    const sender =
      "customType" in message ? (parseRoutedDetails(message.details)?.sender ?? "") : message.sender;

    return { message: { sender, text: routedBody(message.text, sender) }, delivery };
  });
