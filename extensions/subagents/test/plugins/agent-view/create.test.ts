import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { KeyPress } from "../../../../../core/adapter/contract.ts";
import type { FakeForm } from "../../../../../core/test/helpers/fake-form.ts";
import { parseDefinition } from "../../../src/plugins/agent-definitions/loader.ts";
import { agentRegistryPlugin } from "../../../src/plugins/agent-registry/index.ts";
import { parseCreateArgs, shippedAgentNames } from "../../../src/plugins/agent-view/create.ts";
import { agentViewPlugin } from "../../../src/plugins/agent-view/index.ts";
import { createHarness, PACKAGE_ROOT } from "../../helpers/harness.ts";

const enter: KeyPress = { name: "enter" };

const setup = () => {
  const harness = createHarness([agentRegistryPlugin, agentViewPlugin]);
  const { host } = harness;
  const userFile = (name: string) => join(host.info.agentDir, "agents", `${name}.md`);
  const projectFile = (name: string) => join(host.info.cwd, ".pi", "agents", `${name}.md`);
  const warnings = () => host.notices.filter((notice) => notice.level === "warning").map((n) => n.message);

  return { ...harness, userFile, projectFile, warnings };
};

const fill = (form: FakeForm, answers: string[]) => {
  answers.forEach((answer) => {
    form.type(answer);
    form.press(enter);
  });
};

describe("/agents create", () => {
  it("parses the name and the optional project scope", () => {
    expect(parseCreateArgs("docs")).toEqual({ name: "docs", project: false });
    expect(parseCreateArgs(" docs  project ")).toEqual({ name: "docs", project: true });
    expect(parseCreateArgs("")).toHaveProperty("error");
    expect(parseCreateArgs("docs user")).toHaveProperty("error");
    expect(parseCreateArgs("docs project extra")).toHaveProperty("error");
    expect(parseCreateArgs("-docs")).toHaveProperty("error");
  });

  it("reads the shipped names from both shipped folders", () => {
    const names = shippedAgentNames(PACKAGE_ROOT);

    expect(names.has("implementer")).toBe(true);
    expect(names.has("scout")).toBe(true);
  });

  it("asks for description, kind and model, writes a user agent and tells to /reload", async () => {
    const { host, userFile } = setup();
    const running = host.runCommand("agents", "create docs-writer");
    const form = host.form();

    expect(form.render(100).join("\n")).toContain("New agent docs-writer");

    fill(form, ["Use for docs."]);
    form.press({ name: "down" }, enter);
    fill(form, ["provider/model-id:low"]);
    await running;

    const source = readFileSync(userFile("docs-writer"), "utf8");
    const { definition, errors } = parseDefinition(source, "x", "user");

    expect(errors).toEqual([]);
    expect(definition).toMatchObject({
      name: "docs-writer",
      description: "Use for docs.",
      model: "provider/model-id",
      thinking: "low",
      mcp: false,
      subagents: [],
    });
    expect(host.notices.at(-1)?.message).toContain(userFile("docs-writer"));
    expect(host.notices.at(-1)?.message).toContain("/reload");
  });

  it("writes a project agent only in a trusted project", async () => {
    const { host, projectFile, warnings } = setup();

    await host.runCommand("agents", "create local project");

    expect(warnings().at(-1)).toContain("trusted project");
    expect(host.forms).toHaveLength(0);

    host.info.projectTrusted = true;

    const running = host.runCommand("agents", "create local project");

    fill(host.form(), ["", "", ""]);
    await running;

    expect(readFileSync(projectFile("local"), "utf8")).toContain("mcp: true");
  });

  it("refuses a shipped name and an existing file", async () => {
    const { host, userFile, warnings } = setup();

    await host.runCommand("agents", "create scout");

    expect(warnings().at(-1)).toContain("shipped agent");

    mkdirSync(join(host.info.agentDir, "agents"), { recursive: true });
    writeFileSync(userFile("mine"), "keep");

    await host.runCommand("agents", "create mine");

    expect(warnings().at(-1)).toContain("already exists");
    expect(readFileSync(userFile("mine"), "utf8")).toBe("keep");
    expect(host.forms).toHaveLength(0);
  });

  it("writes nothing when the form is cancelled or the model has spaces", async () => {
    const { host, userFile, warnings } = setup();
    const cancelled = host.runCommand("agents", "create quiet");

    host.form().press({ name: "escape" });
    await cancelled;

    const spaced = host.runCommand("agents", "create quiet");

    fill(host.form(), ["d", "", "provider/a b"]);
    await spaced;

    expect(warnings().at(-1)).toContain("without spaces");
    expect(existsSync(userFile("quiet"))).toBe(false);
  });

  it("writes the lead template without a form outside the TUI", async () => {
    const { host, userFile } = setup();

    host.info.mode = "print";
    await host.runCommand("agents", "create batch");

    expect(readFileSync(userFile("batch"), "utf8")).toContain("model: inherit");
  });

  it("offers create in completion and in the description", () => {
    const { host } = setup();
    const command = host.commands.get("agents");

    expect(command?.complete?.("cr")?.map((item) => item.value)).toEqual(["create"]);
    expect(command?.description).toContain("/agents create <name> [project]");
  });
});
