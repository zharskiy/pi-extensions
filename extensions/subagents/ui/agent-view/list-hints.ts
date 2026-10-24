import type { KeyHint } from "../../../../ui-kit/index.ts";
import type { AgentRecord } from "../../core/model/types.ts";
import { stopWords } from "../components/state-text.ts";

const EXITS: KeyHint[] = [
  ["esc", "to close"],
  ["→", "to main session"],
];

export const listHint = (selected: AgentRecord | undefined): KeyHint[] => {
  if (!selected) {
    return [...EXITS];
  }

  return [
    ["↑↓", "to select"],
    ["enter", "to view"],
    ["x", stopWords(selected.state)],
    ["shift+x", "to stop all"],
    ...EXITS,
  ];
};
