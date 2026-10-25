import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SkillInfo } from "../../../../../platform/pi-adapter/index.ts";
import {
  agentDirs,
  autosetupBrief,
  candidateSkills,
  hasSkillsOverride,
  INTERACTIVE_TERMS,
  isChore,
  isLead,
  leftOutText,
  projectListing,
} from "../../../core/agent-setup/autosetup.ts";
import type { AgentDefinition } from "../../../core/model/agent-record.ts";
import { tempDir } from "../../support/subagents-harness.ts";

const INFO = { cwd: "/work/app", agentDir: "/home/me/.pi/agent" };

const DIRS = agentDirs(INFO, "/pkg");

const definition = (patch: Partial<AgentDefinition> & Pick<AgentDefinition, "name" | "path">) =>
  ({
    description: `${patch.name} does its job`,
    limit: 100_000,
    tools: ["read", "bash"],
    skills: [],
    subagents: [],
    prompt: "",
    source: "builtin",
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
  it("takes the path relative to the agents dir the file came from", () => {
    expect(isLead(definition({ name: "reviewer", path: "/pkg/agents/leads/reviewer.md" }), DIRS)).toBe(true);
    expect(isLead(definition({ name: "scout", path: "/pkg/agents/chores/scout.md" }), DIRS)).toBe(false);
    expect(
      isLead(definition({ name: "mine", source: "user", path: "/home/me/.pi/agent/agents/mine.md" }), DIRS),
    ).toBe(true);
    expect(
      isLead(
        definition({ name: "mine", source: "user", path: "/home/me/.pi/agent/agents/chores/mine.md" }),
        DIRS,
      ),
    ).toBe(false);
    expect(
      isLead(
        definition({ name: "mine", source: "project", path: "/work/app/.pi/agents/chores/mine.md" }),
        DIRS,
      ),
    ).toBe(false);
  });

  it("does not count a chores folder above the agents dir", () => {
    const dirs = agentDirs({ cwd: "/chores/app", agentDir: "/chores/agent" }, "/chores/pkg");

    expect(isLead(definition({ name: "reviewer", path: "/chores/pkg/agents/leads/reviewer.md" }), dirs)).toBe(
      true,
    );
    expect(
      isLead(definition({ name: "mine", source: "project", path: "/chores/app/.pi/agents/mine.md" }), dirs),
    ).toBe(true);
  });

  it("leaves out an agent with every skill", () => {
    expect(
      isLead(definition({ name: "general", path: "/pkg/agents/leads/general.md", skills: "all" }), DIRS),
    ).toBe(false);
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
  const files: Record<string, string> = {
    "/a": "---\nname: a\ndescription: Asks\n---\nFirst ASK THE USER which branch to use.",
    "/b": "---\nname: b\ndescription: Uses the questionnaire tool\n---\nReads the diff.",
    "/c": "No frontmatter, calls askuserquestion.",
  };
  const read = (path: string) => {
    if (path === "/broken") {
      throw new Error("EACCES");
    }

    return files[path];
  };

  it("leaves out skills whose body names an interactive term, in any case", () => {
    const catalog = [
      skill("a", { path: "/a" }),
      skill("b", { path: "/b" }),
      skill("c", { path: "/c" }),
      skill("gone", { path: "/gone" }),
      skill("broken", { path: "/broken" }),
    ];
    const { candidates, interactive } = candidateSkills(catalog, read);

    expect(interactive).toEqual(["a", "c"]);
    expect(candidates.map((entry) => entry.name)).toEqual(["b", "gone", "broken"]);
  });

  it("matches every listed term", () => {
    const catalog = INTERACTIVE_TERMS.map((term, index) => skill(`s${index}`, { path: term }));

    expect(candidateSkills(catalog, (path) => `Then ${path}.`).candidates).toEqual([]);
  });

  it("names the left-out skills for the notice", () => {
    expect(leftOutText([])).toBe("");
    expect(leftOutText(["a", "c"])).toBe("; left out, interactive: a, c");
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
    leads: [definition({ name: "reviewer", path: "/pkg/agents/leads/reviewer.md", skills: ["docs"] })],
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
