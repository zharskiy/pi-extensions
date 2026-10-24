import { describe, expect, it } from "vitest";
import { createSkillInventory, type SkillFile } from "../../../pi-adapter/child/pi-skills.ts";

const skill = (name: string, path = `/discovered/${name}/SKILL.md`): SkillFile => ({
  name,
  description: `${name} skill`,
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
});
