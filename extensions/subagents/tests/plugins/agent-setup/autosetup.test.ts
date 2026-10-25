import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SkillInfo } from "../../../../../platform/pi-adapter/index.ts";
import {
  autosetupBrief,
  candidateSkills,
  hasSkillsOverride,
  INTERACTIVE_TERMS,
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
    subagents: ["scout"],
    prompt: "",
    source: "builtin",
    path: `/pkg/agents/leads/${patch.name}.md`,
    ...patch,
  }) as AgentDefinition;

const skill = (name: string, patch: Partial<SkillInfo> = {}): SkillInfo => ({
  name,
  description: `${name} helps`,
  scope: "user",
  path: `/skills/${name}/SKILL.md`,
  ...patch,
});

describe("hasSkillsOverride", () => {
  it("is true only when some agent overrides its skills", () => {
    expect(hasSkillsOverride({}, ["scout"])).toBe(false);
    expect(hasSkillsOverride({ reviewer: { thinking: "low" } }, ["scout"])).toBe(false);
    expect(hasSkillsOverride({ scout: { thinking: "low" }, reviewer: { skills: [] } }, ["scout"])).toBe(true);
  });

  it("ignores a skills override on a chore", () => {
    expect(hasSkillsOverride({ scout: { skills: ["docs"] } }, ["scout"])).toBe(false);
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
    leads: [
      definition({ name: "reviewer", skills: ["docs"] }),
      definition({ name: "general", skills: "all" }),
    ],
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
    expect(leads?.split("\n")).toEqual([
      "- reviewer: reviewer does its job | tools: read, bash | skills: docs",
      "- general: general does its job | tools: read, bash | skills: all (every skill of its caller)",
    ]);
    expect(skills?.split("\n")).toEqual([
      "- docs [project]: docs helps",
      "- empty (no description)",
      `- long: ${"x".repeat(197)}...`,
    ]);
    expect(other).toBe("{{other}}");
  });
});
