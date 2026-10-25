import { describe, expect, it } from "vitest";
import { createSkillInventory, resourceScope } from "../child/skills.ts";
import type { SkillInfo } from "../index.ts";
import { sessionSkillFiles } from "../runtime/extension.ts";

const skill = (name: string, path = `/discovered/${name}/SKILL.md`): SkillInfo => ({
  name,
  description: `${name} skill`,
  scope: "user",
  path,
});

const scope = { cwd: "/project", agentDir: "/agent", projectTrusted: true };

describe("skill inventory", () => {
  it("lists the loaded skills until the first scan, then adds discovered skills by new names only", async () => {
    const loaded = [skill("docs", "/cli/docs/SKILL.md")];
    const inventory = createSkillInventory(
      () => loaded,
      async () => [skill("git"), skill("docs")],
    );

    expect(inventory.files()).toEqual(loaded);

    await inventory.scan(scope);

    expect(inventory.files()).toEqual([...loaded, skill("git")]);
  });

  it("falls back to the loaded skills when a scan fails and lets the error reach pi", async () => {
    let fail = false;
    const inventory = createSkillInventory(
      () => [skill("docs")],
      async () => {
        if (fail) {
          throw new Error("unreadable");
        }

        return [skill("git")];
      },
    );

    await inventory.scan(scope);
    fail = true;

    await expect(inventory.scan(scope)).rejects.toThrow("unreadable");

    expect(inventory.files()).toEqual([skill("docs")]);
  });

  it("takes a loaded skill's scope from the source pi reports for its command", () => {
    const command = (name: string, scope: string, path: string) => ({
      name: `skill:${name}`,
      source: "skill",
      description: `${name} skill`,
      sourceInfo: { path, source: "local", scope, origin: "top-level" },
    });
    const pi = {
      getCommands: () =>
        [
          command("docs", "project", "/project/.agents/skills/docs/SKILL.md"),
          command("git", "user", "/agent/skills/git/SKILL.md"),
          command("style", "temporary", "/tmp/style/SKILL.md"),
          { name: "mcp", source: "extension", sourceInfo: { path: "builtin:mcp" } },
        ] as never,
    };

    expect(sessionSkillFiles(pi)).toEqual([
      { ...skill("docs", "/project/.agents/skills/docs/SKILL.md"), scope: "project" },
      skill("git", "/agent/skills/git/SKILL.md"),
      { ...skill("style", "/tmp/style/SKILL.md"), scope: "temporary" },
    ]);
  });

  it("takes a discovered skill's scope from the resource that holds it, else from where it sits", () => {
    const resource = (path: string, scope: "project" | "user") => ({
      path,
      enabled: true,
      metadata: { source: "local", scope, origin: "top-level" as const },
    });
    const resources = [resource("/shared", "user"), resource("/shared/team", "project")];

    expect(resourceScope(resources, "/shared/team/x/SKILL.md", "/project")).toBe("project");
    expect(resourceScope(resources, "/shared/y/SKILL.md", "/project")).toBe("user");
    expect(resourceScope(resources, "/project/z/SKILL.md", "/project")).toBe("project");
    expect(resourceScope(resources, "/project-other/z/SKILL.md", "/project")).toBe("user");
  });
});
