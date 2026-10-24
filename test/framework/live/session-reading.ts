type SessionItem = { kind: string; text?: string; toolCalls?: { name: string; args: unknown }[] };

type ToolOutput = { toolName: string; text: string };

const COMMAND_MAX = 80;

const COMMANDS_MAX = 8;

export const bashCommands = (items: SessionItem[]) =>
  items.flatMap((item) =>
    (item.kind === "assistant" ? (item.toolCalls ?? []) : []).flatMap((call) => {
      const command = (call.args as { command?: unknown } | undefined)?.command;

      return call.name === "bash" && typeof command === "string" ? [command] : [];
    }),
  );

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
