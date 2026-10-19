import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentDefinitionsPlugin } from "../../../src/plugins/agent-definitions/index.ts";
import { agentRegistryPlugin } from "../../../src/plugins/agent-registry/index.ts";
import { agentSetupPlugin } from "../../../src/plugins/agent-setup/index.ts";
import { SETUP_USAGE } from "../../../src/plugins/agent-setup/line.ts";
import { agentViewPlugin } from "../../../src/plugins/agent-view/index.ts";
import { createHarness, PACKAGE_ROOT } from "../../helpers/harness.ts";

const setup = () => {
  const harness = createHarness([
    agentRegistryPlugin,
    agentDefinitionsPlugin,
    agentSetupPlugin,
    agentViewPlugin,
  ]);
  const { host, runtime } = harness;
  const userDir = join(host.info.agentDir, "agents");
  const projectDir = join(host.info.cwd, ".pi", "agents");
  const errors = () => host.notices.filter((notice) => notice.level === "error").map((n) => n.message);

  runtime.skills = ["docs", "sql"];
  runtime.skillDescriptions = { docs: "Write project docs", sql: "Review SQL migrations" };

  const briefs = () =>
    host.hidden
      .filter((entry) => entry.message.customType === "pi-subagents-create")
      .map((entry) => entry.message.text);

  return { ...harness, userDir, projectDir, errors, briefs };
};

const shippedProviders = () => [
  ...new Set(
    readdirSync(join(PACKAGE_ROOT, "agents"), { recursive: true, encoding: "utf8" })
      .filter((file) => file.endsWith(".md"))
      .flatMap((file) =>
        readFileSync(join(PACKAGE_ROOT, "agents", file), "utf8")
          .split("\n")
          .flatMap((line) => /^model:\s*([^\s/]+)\//.exec(line)?.[1] ?? []),
      ),
  ),
];

describe("/agents create", () => {
  it("sends the main session a brief with the taken names, skills, skeleton and user dir", async () => {
    const { host, briefs, userDir } = setup();

    await host.runCommand("agents", "create");

    expect(briefs()).toHaveLength(1);

    const brief = briefs()[0] ?? "";

    expect(brief).toContain("The user ran /agents create and wants a new agent");
    expect(brief).toContain(join(userDir, "<name>.md"));
    expect(brief).toMatch(/Names taken: .*\bscout\b/);
    expect(brief).toContain("implementer");
    expect(brief).toContain("- docs: Write project docs\n- sql: Review SQL migrations");
    expect(brief).toContain("name: <name>");
    expect(brief).toContain("agree on a short name with the user (or propose one) before writing.");
    expect(brief).toContain(
      "ask the user only what is missing, in one message, and stop there until they answer.",
    );
    expect(brief).toContain("Otherwise write the file now, without asking anything.");
    expect(brief).toContain("Lead skeleton:");
    expect(brief).toContain("Chore skeleton:");
    expect(brief).toContain("tools: [read, grep, find, ls]\n");
    expect(brief).toContain("mcp: false");
    expect(brief).toContain("subagents: [scout]");
    expect(host.sent).toEqual([]);
    expect(brief).not.toContain("{{");
    expect(existsSync(userDir)).toBe(false);
    expect(host.notices.at(-1)).toEqual({
      message: "pi-subagents: asked the main session to create the agent; answer its questions, then /reload",
      level: "info",
    });
  });

  it("offers the project dir only in a trusted project", async () => {
    const { host, briefs, userDir, projectDir } = setup();

    await host.runCommand("agents", "create");

    expect(briefs()[0]).not.toContain(projectDir);
    expect(briefs()[0]).toContain(
      `Write it to ${join(userDir, "<name>.md")}. This project is not trusted, so project agents are not loaded; do not write one.`,
    );

    host.info.projectTrusted = true;
    await host.runCommand("agents", "create");

    expect(briefs()[1]).toContain(join(userDir, "<name>.md"));
    expect(briefs()[1]).toContain(join(projectDir, "<name>.md"));
    expect(briefs()[1]).not.toContain("not trusted");
  });

  it("names the file for a given name, in the user or the trusted project dir", async () => {
    const { host, briefs, userDir, projectDir } = setup();

    await host.runCommand("agents", "create reviewer-sql");

    expect(briefs()[0]).toContain("The user ran /agents create reviewer-sql and");
    expect(briefs()[0]).toContain("Its name is reviewer-sql. ");
    expect(briefs()[0]).toContain(`Write it to ${join(userDir, "reviewer-sql.md")}.`);
    expect(briefs()[0]).not.toContain("agree on a short name");

    host.info.projectTrusted = true;
    await host.runCommand("agents", "create reviewer-sql project");

    expect(briefs()[1]).toContain(`Write it to ${join(projectDir, "reviewer-sql.md")}.`);
  });

  it("passes a purpose quoted and asks for a name", async () => {
    const { host, briefs } = setup();

    await host.runCommand("agents", "create a reviewer for SQL migrations");

    expect(briefs()[0]).toContain("The user ran /agents create a reviewer for SQL migrations and");
    expect(briefs()[0]).toContain('The user describes it as: "a reviewer for SQL migrations". ');
    expect(briefs()[0]).toContain("agree on a short name with the user");
  });

  it("names no provider", async () => {
    const { host, briefs } = setup();

    await host.runCommand("agents", "create");

    const providers = shippedProviders();

    expect(providers.length).toBeGreaterThan(0);
    providers.forEach((provider) => {
      expect(briefs()[0]?.toLowerCase()).not.toContain(provider.toLowerCase());
    });
  });

  it("refuses a shipped name, an existing file, an untrusted project and a bad name, sending nothing", async () => {
    const { host, briefs, userDir, errors } = setup();

    await host.runCommand("agents", "create scout");

    expect(errors().at(-1)).toBe('pi-subagents: "scout" is a shipped agent; pick another name');

    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, "mine.md"), "keep");
    await host.runCommand("agents", "create mine");

    expect(errors().at(-1)).toBe(`pi-subagents: ${join(userDir, "mine.md")} already exists; edit it instead`);

    await host.runCommand("agents", "create local project");

    expect(errors().at(-1)).toBe(
      "pi-subagents: project agents need a trusted project; create a user agent with /agents create <name>",
    );

    await host.runCommand("agents", "create my.agent project");

    expect(errors().at(-1)).toContain('agent name "my.agent" must use');
    expect(briefs()).toEqual([]);
    expect(readFileSync(join(userDir, "mine.md"), "utf8")).toBe("keep");
  });

  it("sends the brief outside the terminal UI too", async () => {
    const { host, briefs } = setup();

    host.info.mode = "rpc";
    await host.runCommand("agents", "create batch");

    expect(briefs()).toHaveLength(1);
    expect(host.forms).toHaveLength(0);
  });

  it("offers create in completion and in the description", () => {
    const { host } = setup();
    const command = host.commands.get("agents");
    const usage = "/agents create [<name> [project] | <what the agent is for>]";

    expect(command?.complete?.("cr")?.map((item) => item.value)).toEqual(["create"]);
    expect(command?.complete?.("cr")?.[0]?.label).toBe(`create · new agent: ${usage}`);
    expect(command?.description).toBe(
      `Agents: list, setup or create. Usage: /agents [view | <id>] | ${usage} | ${SETUP_USAGE}`,
    );
  });

  it("reports a clear error when the agent-setup plugin is off", async () => {
    const harness = createHarness([agentRegistryPlugin, agentViewPlugin]);

    await harness.host.runCommand("agents", "create docs");
    await harness.host.runCommand("agents", "setup");

    expect(harness.host.notices.map((notice) => notice.message)).toEqual([
      "pi-subagents: /agents create needs the agent-setup plugin, which is disabled",
      "pi-subagents: /agents setup needs the agent-setup plugin, which is disabled",
    ]);
    expect(
      harness.host.commands
        .get("agents")
        ?.complete?.("")
        ?.map((item) => item.value),
    ).toEqual(["view"]);
  });
});
