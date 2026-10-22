import { describe, expect, it } from "vitest";
import { createSkillInventory, mergeSkills, type SkillFile } from "../../adapter/pi-skills.ts";

const skill = (name: string, path = `/discovered/${name}/SKILL.md`): SkillFile => ({
  name,
  description: `${name} skill`,
  path,
});

const scope = { cwd: "/project", agentDir: "/agent", projectTrusted: true };

describe("skill inventory", () => {
  it("puts the main session's loaded skills first and adds discovered skills by new names only", () => {
    const loaded = [skill("docs", "/cli/docs/SKILL.md")];

    expect(mergeSkills(loaded, [skill("git"), skill("docs")])).toEqual([
      skill("docs", "/cli/docs/SKILL.md"),
      skill("git"),
    ]);
  });

  it("lists the loaded skills until the first scan, then the merged inventory", async () => {
    const loaded = [skill("docs", "/cli/docs/SKILL.md")];
    const scopes: unknown[] = [];
    const inventory = createSkillInventory(
      () => loaded,
      async (where) => {
        scopes.push(where);

        return [skill("git")];
      },
    );

    expect(inventory.files()).toEqual(loaded);

    await inventory.scan(scope);

    expect(inventory.files()).toEqual([...loaded, skill("git")]);
    expect(scopes).toEqual([scope]);
  });

  it("falls back to the loaded skills when a scan fails", async () => {
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
    await inventory.scan(scope);

    expect(inventory.files()).toEqual([skill("docs")]);
  });
});
