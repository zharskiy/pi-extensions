import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SkillInfo } from "../../../../../platform/pi-adapter/index.ts";
import { loadDefinitions } from "../../../core/agent-definitions/loader.ts";
import {
  autosetupBrief,
  candidateSkills,
  hasSkillsOverride,
  INTERACTIVE_TERMS,
  isChore,
  isLead,
  projectListing,
} from "../../../core/agent-setup/autosetup.ts";
import type { AgentDefinition } from "../../../core/model/agent-record.ts";
import { tempDir } from "../../support/subagents-harness.ts";

const definition = (patch: Partial<AgentDefinition> & Pick<AgentDefinition, "name">) =>
  ({
    description: `${patch.name} does its job`,
    limit: 100_000,
    tools: ["read", "bash"],
    skills: [],
    subagents: [],
    prompt: "",
    source: "builtin",
    path: `/pkg/agents/leads/${patch.name}.md`,
    relativePath: `leads/${patch.name}.md`,
    ...patch,
  }) as AgentDefinition;

const skill = (name: string, patch: Partial<SkillInfo> = {}): SkillInfo => ({
  name,
  description: `${name} helps`,
  scope: "user",
  path: `/skills/${name}/SKILL.md`,
  ...patch,
});

describe("isChore", () => {
  it("is true only for a chores directory segment", () => {
    expect(isChore(join("chores", "scout.md"))).toBe(true);
    expect(isChore("chores\\mine.md")).toBe(true);
    expect(isChore("team/chores/mine.md")).toBe(true);
    expect(isChore(join("leads", "reviewer.md"))).toBe(false);
    expect(isChore("mine.md")).toBe(false);
    expect(isChore("chores.md")).toBe(false);
  });
});

describe("isLead", () => {
  it("leaves out agents under a chores folder of their agents dir", () => {
    expect(isLead(definition({ name: "reviewer", relativePath: join("leads", "reviewer.md") }))).toBe(true);
    expect(isLead(definition({ name: "mine", relativePath: "mine.md" }))).toBe(true);
    expect(isLead(definition({ name: "scout", relativePath: join("chores", "scout.md") }))).toBe(false);
  });

  it("does not count a chores folder above the agents dir", () => {
    const dir = join(tempDir(), "chores", "agents");

    mkdirSync(join(dir, "leads"), { recursive: true });
    writeFileSync(
      join(dir, "leads", "mine.md"),
      "---\nname: mine\ndescription: d\nlimit: 50000\ntools: []\nskills: []\nsubagents: []\n---\n",
    );

    const loaded = loadDefinitions([{ path: dir, source: "project" }]).definitions.get("mine");

    expect(loaded && isLead(loaded)).toBe(true);
  });

  it("leaves out an agent with every skill", () => {
    expect(isLead(definition({ name: "general", skills: "all" }))).toBe(false);
  });
});

describe("hasSkillsOverride", () => {
  it("is true only when some agent overrides its skills", () => {
    expect(hasSkillsOverride({})).toBe(false);
    expect(hasSkillsOverride({ scout: { thinking: "low" } })).toBe(false);
    expect(hasSkillsOverride({ scout: { thinking: "low" }, reviewer: { skills: [] } })).toBe(true);
  });
});

describe("candidateSkills", () => {
  const skillFile = (dir: string, name: string, text: string) => {
    const path = join(dir, `${name}.md`);

    writeFileSync(path, text);

    return skill(name, { path });
  };

  it("leaves out skills whose body names an interactive term, in any case", () => {
    const dir = tempDir();
    const catalog = [
      skillFile(dir, "a", "---\nname: a\ndescription: Asks\n---\nFirst ASK THE USER which branch to use."),
      skillFile(dir, "b", "---\nname: b\ndescription: Uses the questionnaire tool\n---\nReads the diff."),
      skillFile(dir, "c", "No frontmatter, calls askuserquestion."),
      skill("gone", { path: join(dir, "gone.md") }),
    ];
    const { candidates, interactive } = candidateSkills(catalog);

    expect(interactive).toEqual(["a", "c"]);
    expect(candidates.map((entry) => entry.name)).toEqual(["b", "gone"]);
  });

  it("matches every listed term", () => {
    const dir = tempDir();
    const catalog = INTERACTIVE_TERMS.map((term, index) => skillFile(dir, `s${index}`, `Then ${term}.`));

    expect(candidateSkills(catalog).candidates).toEqual([]);
  });
});

describe("projectListing", () => {
  it("lists top-level entries with folders marked, skipping .git and node_modules", () => {
    const dir = tempDir();

    ["src", ".git", "node_modules"].forEach((name) => {
      mkdirSync(join(dir, name));
    });
    writeFileSync(join(dir, "package.json"), "{}");

    expect(projectListing(dir)).toBe("package.json, src/");
  });

  it("bounds the listing and reports a folder it cannot read", () => {
    const dir = tempDir();

    ["a", "b", "c"].forEach((name) => {
      writeFileSync(join(dir, name), "");
    });

    expect(projectListing(dir, 2)).toBe("a, b and 1 more");
    expect(projectListing(join(dir, "missing"))).toMatch(/^\(cannot list: /);
  });
});

describe("autosetupBrief", () => {
  const brief = autosetupBrief({
    template: "{{project}}#{{listing}}#{{leads}}#{{skills}}#{{other}}",
    cwd: "/work/app",
    listing: "src/",
    leads: [definition({ name: "reviewer", skills: ["docs"] })],
    candidates: [
      skill("docs", { scope: "project" }),
      skill("empty", { description: "" }),
      skill("long", { description: "x".repeat(300) }),
    ],
  });

  it("fills the project, the leads and the skills", () => {
    const [project, listing, leads, skills, other] = brief.split("#");

    expect(project).toBe("app (/work/app)");
    expect(listing).toBe("src/");
    expect(leads).toBe("- reviewer: reviewer does its job | tools: read, bash | skills: docs");
    expect(skills?.split("\n")).toEqual([
      "- docs [project]: docs helps",
      "- empty (no description)",
      `- long: ${"x".repeat(197)}...`,
    ]);
    expect(other).toBe("{{other}}");
  });
});
