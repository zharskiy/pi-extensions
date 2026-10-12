import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getPackageDir, type NormalizedBuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { replaceMainPrompt, restoredSections } from "../../adapter/main-prompt.ts";

const RESTORED_SECTIONS = ["tools", "rules", "docs"] as const;

type BuildSections = (options: NormalizedBuildSystemPromptOptions) => Record<string, string>;

const loadPiSections = async (): Promise<BuildSections> => {
  const url = pathToFileURL(join(getPackageDir(), "dist", "core", "system-prompt.js")).href;
  const module = (await import(url)) as { buildSystemPromptSections: BuildSections };

  return module.buildSystemPromptSections;
};

const unwrap = (name: string, text: string) => text.replace(`<${name}>\n`, "").replace(`\n</${name}>`, "");

const optionsWith = (
  patch: Partial<NormalizedBuildSystemPromptOptions>,
): NormalizedBuildSystemPromptOptions => ({
  selectedTools: ["read", "bash", "edit", "write"],
  hiddenTools: [],
  toolSnippets: { read: "Read files", bash: "Run commands", edit: "Edit files" },
  toolGuidelines: { read: ["Read before editing"], edit: ["Keep edits small", "Read before editing"] },
  promptGuidelines: ["Use run_agent for large searches"],
  appendSystemPrompt: "",
  sections: {},
  cwd: "/repo",
  contextFiles: [],
  skills: [],
  ...patch,
});

describe("main session prompt replacement", () => {
  it.each([
    ["bash without search tools", {}],
    ["search tools present", { selectedTools: ["read", "bash", "grep", "find", "ls"] }],
    ["hidden and powershell tools", { selectedTools: ["read", "bash", "powershell"], hiddenTools: ["read"] }],
    ["no tools", { selectedTools: [], toolSnippets: {} }],
  ])("restores pi's tools, rules and docs sections exactly (%s)", async (_label, patch) => {
    const buildSystemPromptSections = await loadPiSections();
    const options = optionsWith(patch);
    const expected = buildSystemPromptSections(options);
    const restored = restoredSections(options);

    RESTORED_SECTIONS.forEach((name) => {
      expect(restored[name]).toBe(unwrap(name, expected[name] ?? ""));
    });
  });

  it("replaces the preamble and keeps the dropped sections and other extensions' sections", async () => {
    const buildSystemPromptSections = await loadPiSections();
    const options = optionsWith({ sections: { other: "Other extension." } });
    const original = buildSystemPromptSections(optionsWith({}));

    replaceMainPrompt(options, "# Main session\nCoordinate agents.");

    const replaced = buildSystemPromptSections(options);

    expect(replaced.preamble).toBe("# Main session\nCoordinate agents.");
    expect(replaced.tools).toBe(original.tools);
    expect(replaced.rules).toBe(original.rules);
    expect(replaced.docs).toBe(original.docs);
    expect(replaced.cwd).toBe(original.cwd);
    expect(replaced.other).toBe("<other>\nOther extension.\n</other>");
  });
});
