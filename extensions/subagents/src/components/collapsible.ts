import type { ThemeLike } from "../../../../core/adapter/contract.ts";

export type CollapsibleSection = {
  title: string;
  lines: string[];
  collapsed: boolean;
};

export const toggleSection = (sections: CollapsibleSection[], index: number): CollapsibleSection[] =>
  sections.map((section, position) =>
    position === index ? { ...section, collapsed: !section.collapsed } : section,
  );

export const setAllCollapsed = (sections: CollapsibleSection[], collapsed: boolean): CollapsibleSection[] =>
  sections.map((section) => ({ ...section, collapsed }));

export type SectionLines = { lines: string[]; headerRows: number[] };

export const renderSections = (
  sections: CollapsibleSection[],
  focused: number,
  theme: ThemeLike,
  wrap: (text: string) => string[],
): SectionLines => {
  const lines: string[] = [];

  const headerRows = sections.map((section, index) => {
    const marker = section.collapsed ? "▸" : "▾";
    const count = theme.fg("dim", `(${section.lines.length} lines)`);
    const title =
      index === focused ? theme.fg("accent", theme.bold(section.title)) : theme.bold(section.title);
    const row = lines.length;

    lines.push(`${index === focused ? "›" : " "} ${marker} ${title} ${count}`);

    if (!section.collapsed) {
      section.lines.forEach((line) => {
        wrap(line).forEach((part) => {
          lines.push(`    ${part}`);
        });
      });
    }

    return row;
  });

  return { lines, headerRows };
};
