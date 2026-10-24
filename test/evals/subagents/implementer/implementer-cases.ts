export type ImplementerCase = { sha: string; task: string; tests: string[] };

export const implementerCases: ImplementerCase[] = [
  {
    sha: "1622d24",
    task: 'In core/adapter/pi-editor.ts our editor keeps its shared state on globalThis under Symbol.for("pi-extensions.editor-hooks"), so every copy of the package uses one record. A record left there by an older copy of the package has only `emptyLeft` and `emptyDown`, no `history`, and then ↑ prompt recall in our editor breaks. Make the editor fill in whatever fields are missing on an existing record instead of assuming it is complete.',
    tests: ["core/test/adapter/pi-editor.test.ts"],
  },
  {
    sha: "5af06ac",
    task: "In the notifications extension (extensions/notifications/src/notifications.ts) only one awaiting-input wait is tracked at a time. When the questionnaire form is waiting and a pi dialog opens and closes over it, or the other way round, the wait that is still open never gets its `pi needs your input` notification, and the idle notification is not held for it either. Track every open wait by its owner: when one closes while another that has not notified yet is still open, restart the dialog delay for it; a notification uses the title of the most recently opened wait that is still open and counts as sent for every open wait; the idle notification waits until every wait has closed.",
    tests: ["extensions/notifications/test/notifications.test.ts"],
  },
  {
    sha: "eb0177e",
    task: "The subagents footer status shows `N agents` while agents run and `/agents to see agents` for a while after the last one finishes. The agent panel already lists every open agent and the run_agent block says how to open the list, so both are just noise. Remove that footer status entirely, along with the setting that controls how long the hint stays and any helper that becomes unused. A settings file that still has the old key must keep loading without a warning.",
    tests: [
      "extensions/subagents/test/components/format.test.ts",
      "extensions/subagents/test/model/settings.test.ts",
      "extensions/subagents/test/plugins/agent-panel/agent-panel.test.ts",
    ],
  },
];
