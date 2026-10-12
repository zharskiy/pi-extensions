import type { Plugin } from "../../model/plugin.ts";
import { type AgentRecord, type Attention, isClosed, MAIN_CALLER } from "../../model/types.ts";

export const TITLE_PREFIX = "pi-subagents";

export const MAX_NAMED = 3;

export const firstLine = (text: string | undefined) =>
  (text ?? "")
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean) ?? "";

export const batchTitle = (terminals: AgentRecord[]) => {
  const named = terminals.slice(0, MAX_NAMED).map((record) => `${record.agent} ${record.state}`);
  const more = terminals.length > MAX_NAMED ? [`+${terminals.length - MAX_NAMED} more`] : [];

  return `${TITLE_PREFIX}: ${named.concat(more).join(", ")}`;
};

export const batchBody = (terminals: AgentRecord[]) => {
  const done = terminals.find((record) => record.state === "done" && firstLine(record.resultText));

  if (done) {
    return firstLine(done.resultText);
  }

  const reported = terminals.find((record) => firstLine(record.error) || firstLine(record.resultText));

  return reported ? firstLine(reported.resultText) || firstLine(reported.error) : "";
};

export const notificationsPlugin: Plugin = {
  id: "notifications",
  requires: ["run-agent"],
  enable: ({ host, bus, services, settings }) => {
    const runner = services.require("runner");
    const asked = new Map<string, Attention>();
    let quiet = false;

    const notify = (title: string, body: string) => {
      if (quiet || !settings.notifications) {
        return;
      }

      host.ui.terminalNotify(title, body);
    };

    host.onSessionStart(() => {
      quiet = false;
    });

    const offClosing = bus.on("session:closing", () => {
      quiet = true;
    });

    const offChanged = bus.on("agent:changed", (record) => {
      const attention = record.attention;

      if (!attention || isClosed(record.state) || asked.get(record.id) === attention) {
        return;
      }

      asked.set(record.id, attention);
      notify(
        `${TITLE_PREFIX}: ${record.id} (${record.agent}) needs input: ${attention.title}`,
        record.description,
      );
    });

    const offSettled = bus.on("batch:settled", ({ callerId, terminals }) => {
      if (callerId === MAIN_CALLER) {
        notify(batchTitle(terminals), batchBody(terminals));
      }
    });

    const offClosed = bus.on("agent:closed", (record) => {
      asked.delete(record.id);

      const announcedWithBatch = record.callerId === MAIN_CALLER && runner.batchSettled(record.batchId);

      if (record.state === "failed" && !announcedWithBatch) {
        notify(`${TITLE_PREFIX}: ${record.id} (${record.agent}) failed`, firstLine(record.error));
      }
    });

    return () => {
      offChanged();
      offClosing();
      offSettled();
      offClosed();
    };
  },
};
