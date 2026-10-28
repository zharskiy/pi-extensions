import { globalRecord } from "./global-record.ts";

type FollowUps = { queued: Map<string, string[]>; taken: WeakSet<object> };

const followUps = () =>
  globalRecord<FollowUps>("follow-ups", () => ({ queued: new Map(), taken: new WeakSet() }));

export const queueFollowUp = (session: string, customType: string) => {
  const { queued } = followUps();

  queued.set(session, [...(queued.get(session) ?? []), customType]);
};

export const takeFollowUp = (session: string, message: object, customType: string) => {
  const { queued, taken } = followUps();

  if (taken.has(message)) {
    return;
  }

  taken.add(message);

  const list = queued.get(session) ?? [];
  const index = list.indexOf(customType);

  if (index >= 0) {
    queued.set(session, list.toSpliced(index, 1));
  }
};

export const dropFollowUps = (session: string) => {
  followUps().queued.delete(session);
};

export const followUpsQueued = (session: string) => (followUps().queued.get(session)?.length ?? 0) > 0;
