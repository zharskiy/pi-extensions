import { type AgentRecord, isClosed } from "../model/types.ts";

export const stopHint = (record: AgentRecord | undefined) => {
  if (!record || isClosed(record.state)) {
    return undefined;
  }

  return record.state === "grace" ? "x again closes now" : "x stop";
};

export const scrollHint = (wheel: boolean) =>
  wheel ? "PgUp/PgDn Home/End wheel scroll" : "PgUp/PgDn Home/End scroll";
