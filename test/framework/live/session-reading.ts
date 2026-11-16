import type { RunEvent } from "../eval-runs/index.ts";

type ToolOutput = { toolName: string; text: string };

const COMMAND_MAX = 80;

const COMMANDS_MAX = 8;

export const bashCommands = (events: RunEvent[]) =>
  events.flatMap((event) => {
    const command =
      event.type === "tool_call" && event.name === "bash"
        ? (event.arguments as { command?: unknown } | undefined)?.command
        : undefined;

    return typeof command === "string" ? [command] : [];
  });

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

export const commandsLine = (commands: string[]) => {
  const shown = commands.slice(0, COMMANDS_MAX).map((command) => oneLine(command).slice(0, COMMAND_MAX));
  const more = commands.length > COMMANDS_MAX ? ", …" : "";

  return shown.length > 0 ? `    bash ${commands.length}: ${shown.join(" · ")}${more}` : "    bash 0";
};

export const largestToolOutput = (results: ToolOutput[], toolName: string) =>
  results
    .filter((result) => result.toolName === toolName)
    .reduce((max, result) => Math.max(max, result.text.length), 0);
