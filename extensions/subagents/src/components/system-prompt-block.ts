import type { PromptRecord } from "../../../../core/adapter/contract.ts";
import type { CollapsibleSection } from "./collapsible.ts";

const splitLines = (text: string) => text.replace(/\r\n/g, "\n").split("\n");

const json = (value: unknown) => splitLines(JSON.stringify(value, null, 2));

export const promptSections = (record: PromptRecord): CollapsibleSection[] => {
  const sections: CollapsibleSection[] = record.sections.map((section) => ({
    title: `System prompt · ${section.name}`,
    lines: splitLines(section.text),
    collapsed: true,
  }));

  const tools = {
    title: `Tools (${record.tools.length})`,
    lines: record.tools.flatMap((tool) => {
      const toolLines = json(tool.parameters).map((line) => `  ${line}`);

      toolLines.unshift(`${tool.name}: ${tool.description}`);

      return toolLines;
    }),
    collapsed: true,
  };

  const skills = {
    title: `Skills (${record.skills.length})`,
    lines: record.skills.map((skill) => `${skill.name}: ${skill.description}`),
    collapsed: true,
  };

  const guidelines = {
    title: `Tool guidelines (${record.guidelines.length})`,
    lines: record.guidelines.map((guideline) => `- ${guideline}`),
    collapsed: true,
  };

  const payload = {
    title: "Provider request (first, as sent)",
    lines: record.providerPayload === undefined ? ["not recorded"] : json(record.providerPayload),
    collapsed: true,
  };

  sections.push(tools, skills, guidelines, payload);

  return sections;
};
