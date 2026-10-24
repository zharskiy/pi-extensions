import type { FormFactory } from "../../../../pi-adapter/index.ts";
import { type SelectOption, selectForm } from "../../../../ui-kit/index.ts";

export const SUBCOMMANDS = ["view", "create", "setup"] as const;

export type Subcommand = (typeof SUBCOMMANDS)[number];

export const SUBCOMMAND_TEXT: Record<Subcommand, string> = {
  view: "agents list",
  create: "new agent",
  setup: "model, thinking and skills per agent",
};

const MENU_TEXT: Record<Subcommand, string> = {
  ...SUBCOMMAND_TEXT,
  create: "new agent; the main session asks what it is for and writes it",
};

export const isSubcommand = (word: string): word is Subcommand =>
  (SUBCOMMANDS as readonly string[]).includes(word);

export const subcommandPicker = (viewText: string): FormFactory<Subcommand | undefined> => {
  const options: SelectOption<Subcommand>[] = [
    { value: "view", label: "view", description: viewText },
    { value: "setup", label: "setup", description: MENU_TEXT.setup },
    { value: "create", label: "create", description: MENU_TEXT.create },
  ];

  return selectForm({ title: "Agents", options });
};
