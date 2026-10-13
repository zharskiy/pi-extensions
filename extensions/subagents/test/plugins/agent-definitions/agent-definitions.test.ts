import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FRONTMATTER_FIELDS } from "../../../src/plugins/agent-definitions/fields.ts";
import { agentDefinitionsPlugin } from "../../../src/plugins/agent-definitions/index.ts";
import { loadDefinitions, parseDefinition } from "../../../src/plugins/agent-definitions/loader.ts";
import { assemblePromptAppend } from "../../../src/plugins/agent-definitions/prompt.ts";
import { parseFrontmatter } from "../../../src/plugins/agent-definitions/yaml-lite.ts";
import { createHarness, PACKAGE_ROOT, tempDir } from "../../helpers/harness.ts";

const writeAgent = (dir: string, file: string, content: string) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), content);
};

const DEFAULT_LISTS: Record<string, string> = { tools: "all", skills: "all" };

const lists = (extra: string, defaults = DEFAULT_LISTS) =>
  Object.entries(defaults)
    .filter(([key]) => !new RegExp(`^${key}:`, "m").test(extra))
    .map(([key, value]) => `${key}: ${value}\n`)
    .join("");

const agentFile = (name: string, description: string, extra = "subagents: []", body = "") =>
  `---\nname: ${name}\ndescription: ${description}\nlimit: 50000\n${lists(extra)}${extra}\n---\n${body}`;

describe("frontmatter", () => {
  it("parses scalars, inline lists, block lists and block text", () => {
    const parsed = parseFrontmatter(
      [
        "---",
        "name: scout",
        'description: "Finds things: fast"',
        "tools: [read, grep]",
        "skills:",
        "  - search",
        "  - 'docs'",
        "limit: 12000",
        "prompt: |",
        "  line one",
        "  line two",
        "unknownKey: ignored-but-kept",
        "---",
        "Body text.",
      ].join("\n"),
    );

    expect(parsed.data).toEqual({
      name: "scout",
      description: "Finds things: fast",
      tools: ["read", "grep"],
      skills: ["search", "docs"],
      limit: 12000,
      prompt: "line one\nline two",
      unknownKey: "ignored-but-kept",
    });

    expect(parsed.body).toBe("Body text.");
  });

  it("treats a file without frontmatter as body only", () => {
    expect(parseFrontmatter("just text")).toEqual({ data: {}, body: "just text" });
  });
});

describe("agent definition parsing", () => {
  it("accepts comma-separated tools", () => {
    const parsed = parseDefinition(
      "---\nname: a\ndescription: d\ntools: read, ls\nskills: []\nworktree: true\nlimit: 60000\nsubagents: []\nmodel: acme/model-a:low\n---\nDo it.",
      "/x/a.md",
      "user",
    );

    expect(parsed.errors).toEqual([]);
    expect(parsed.definition).toMatchObject({
      name: "a",
      tools: ["read", "ls"],
      worktree: true,
      limit: 60000,
      subagents: [],
      model: "acme/model-a",
      thinking: "low",
      prompt: "Do it.",
      source: "user",
    });
  });

  it("ignores keys outside the vocabulary with a warning naming them", () => {
    const parsed = parseDefinition(
      "---\nname: a\ndescription: d\nlimit: 50000\ntools: [read]\nskills: []\nsubagents: []\ncolor: blue\neffort: high\npermissionMode: plan\nprompt: Extra rule.\n---\nBody.",
      "/x/a.md",
      "user",
    );

    expect(parsed.errors).toEqual([]);
    expect(parsed.warnings).toEqual(["unknown field(s) ignored: color, effort, permissionMode, prompt"]);
    expect(parsed.definition).toMatchObject({
      prompt: "Body.",
      tools: ["read"],
      model: undefined,
      thinking: undefined,
      worktree: undefined,
    });
  });

  it("reports every problem of an invalid file", () => {
    const parsed = parseDefinition(
      "---\nname: bad name\nthinking: high\nlimit: 10\nsubagents: 3\nmodel: gpt 6\nworktree: maybe\n---\n",
      "/x/bad.md",
      "user",
    );

    expect(parsed.definition).toBeUndefined();
    expect(parsed.errors).toEqual(
      expect.arrayContaining([
        "description is required",
        "name must be a plain name of letters, digits, '_' and '-', not starting with '-'",
        "limit must be an integer of at least 5000",
        "subagents must be a list or a comma-separated string",
        'model must be name[:thinking] without spaces, got "gpt 6"',
        "worktree must be true or false",
      ]),
    );
  });

  it("requires limit and every list field", () => {
    const parsed = parseDefinition("---\nname: a\ndescription: d\n---\n", "/x/a.md", "user");

    expect(parsed.definition).toBeUndefined();
    expect(parsed.errors).toEqual([
      "limit is required (context limit in tokens, for example limit: 100000)",
      "tools is required (tool names, all for the tools active in the main session, or [] for none)",
      "skills is required (skill names, all for every skill of the main session, or [] for none)",
      "subagents is required (agent names it may start, all for every other agent, or [] for none)",
    ]);
  });

  it("builds the definition from the schema's fields plus the harness internals", () => {
    const parsed = parseDefinition(agentFile("a", "d", "subagents: []", "Body."), "/x/a.md", "project");

    expect(parsed.errors).toEqual([]);
    expect(parsed.warnings).toEqual([]);
    expect(Object.keys(parsed.definition ?? {}).sort()).toEqual(
      [...FRONTMATTER_FIELDS.map((spec) => spec.key), "thinking", "prompt", "source", "path"].sort(),
    );
    expect(parsed.definition).toMatchObject({
      model: undefined,
      worktree: undefined,
      prompt: "Body.",
      source: "project",
    });
  });

  it("warns about a name listed twice in any list field and keeps it once", () => {
    const parsed = parseDefinition(
      "---\nname: a\ndescription: d\nlimit: 50000\ntools: []\nskills: [docs, docs]\nsubagents: []\n---\n",
      "/x/a.md",
      "user",
    );

    expect(parsed.definition?.skills).toEqual(["docs"]);
    expect(parsed.warnings).toEqual(["skills lists entries more than once: docs"]);
  });

  it("accepts a block list of subagents and treats model inherit as the main session's model", () => {
    const parsed = parseDefinition(
      "---\nname: lead\ndescription: d\nlimit: 80000\nmodel: inherit\ntools: all\nskills: all\nsubagents:\n  - explorer\n  - reviewer\n---\n",
      "/x/lead.md",
      "user",
    );

    expect(parsed.errors).toEqual([]);
    expect(parsed.definition?.subagents).toEqual(["explorer", "reviewer"]);
    expect(parsed.definition?.model).toBeUndefined();
  });
});

describe("model field", () => {
  const parse = (extra: string) =>
    parseDefinition(
      `---\nname: a\ndescription: d\nlimit: 50000\n${lists(extra)}subagents: []\n${extra}\n---\n`,
      "/x/a.md",
      "user",
    );

  it("loads a file without a model line with no warnings or errors", () => {
    const parsed = parse("");

    expect(parsed).toMatchObject({ errors: [], warnings: [] });
    expect(parsed.definition).toMatchObject({ model: undefined, thinking: undefined });
  });

  it("accepts a bare model name and a thinking suffix", () => {
    expect(parse("model: model-a:low").definition).toMatchObject({ model: "model-a", thinking: "low" });
    expect(parse("model: acme/model-b:high").definition).toMatchObject({
      model: "acme/model-b",
      thinking: "high",
    });
    expect(parse("model: inherit:max").definition).toMatchObject({ model: undefined, thinking: "max" });
  });

  it("keeps a numeric suffix as part of the model id", () => {
    expect(parse("model: acme/model-a-v1:0").definition?.model).toBe("acme/model-a-v1:0");
  });

  it("treats a thinking field as unknown", () => {
    const parsed = parse("model: model-a\nthinking: low");

    expect(parsed.errors).toEqual([]);
    expect(parsed.warnings).toEqual(["unknown field(s) ignored: thinking"]);
    expect(parsed.definition?.thinking).toBeUndefined();
  });

  it("rejects an invalid thinking suffix", () => {
    expect(parse("model: model-a:extreme").errors).toEqual([
      expect.stringContaining('model: invalid thinking level "extreme"'),
    ]);
  });

  it("inherits the thinking level when the model has no suffix", () => {
    expect(parse("model: acme/model-b").definition?.thinking).toBeUndefined();
  });
});

describe("worktree field", () => {
  const parse = (extra: string) =>
    parseDefinition(agentFile("a", "d", `subagents: []\n${extra}`), "/x/a.md", "user");

  it("is off by default and accepts a boolean", () => {
    expect(parse("").definition?.worktree).toBeUndefined();
    expect(parse("worktree: true").definition?.worktree).toBe(true);
    expect(parse("worktree: false").definition?.worktree).toBe(false);
  });

  it("rejects anything but a boolean", () => {
    const parsed = parse("worktree: yes please");

    expect(parsed.definition).toBeUndefined();
    expect(parsed.errors).toEqual(["worktree must be true or false"]);
  });
});

describe("subagent graph validation", () => {
  const load = (files: Record<string, string>) => {
    const dir = tempDir();

    Object.entries(files).forEach(([name, content]) => {
      writeAgent(dir, `${name}.md`, content);
    });

    return { dir, result: loadDefinitions([{ path: dir, source: "user" }]) };
  };

  it("accepts a tree of known subagents", () => {
    const { result } = load({
      lead: agentFile("lead", "l", "subagents: [worker, scout]"),
      worker: agentFile("worker", "w", "subagents: [scout]"),
      scout: agentFile("scout", "s"),
    });

    expect(result.errors).toEqual([]);
    expect(result.definitions.get("lead")?.subagents).toEqual(["worker", "scout"]);
  });

  it("rejects unknown names, self references and cycles", () => {
    const { dir, result } = load({
      ghost: agentFile("ghost", "g", "subagents: [missing]"),
      narcissus: agentFile("narcissus", "n", "subagents: [narcissus]"),
      ping: agentFile("ping", "p", "subagents: [pong]"),
      pong: agentFile("pong", "p", "subagents: [ping]"),
      ok: agentFile("ok", "o"),
    });

    expect([...result.definitions.keys()]).toEqual(["ok"]);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        { path: join(dir, "ghost.md"), message: "subagents names unknown or invalid agent(s): missing" },
        { path: join(dir, "narcissus.md"), message: "subagents must not include the agent itself" },
        { path: join(dir, "ping.md"), message: "subagents form a cycle: ping -> pong -> ping" },
        { path: join(dir, "pong.md"), message: "subagents form a cycle: pong -> ping -> pong" },
      ]),
    );
  });

  it("drops agents that reference an agent rejected by validation", () => {
    const { dir, result } = load({
      boss: agentFile("boss", "b", "subagents: [ghost]"),
      ghost: agentFile("ghost", "g", "subagents: [missing]"),
    });

    expect(result.definitions.size).toBe(0);
    expect(result.errors).toContainEqual({
      path: join(dir, "boss.md"),
      message: "subagents names unknown or invalid agent(s): ghost",
    });
  });
});

describe("definition loading", () => {
  it("lets project files override user files and user files override built-ins", () => {
    const root = tempDir();
    const builtin = join(root, "builtin");
    const user = join(root, "user");
    const project = join(root, "project");

    writeAgent(builtin, "scout.md", agentFile("scout", "builtin scout"));
    writeAgent(builtin, "solo.md", agentFile("solo", "builtin only"));
    writeAgent(user, "scout.md", agentFile("scout", "user scout"));
    writeAgent(user, "helper.md", agentFile("helper", "user helper"));
    writeAgent(project, "scout.md", agentFile("scout", "project scout"));

    const result = loadDefinitions([
      { path: builtin, source: "builtin" },
      { path: user, source: "user" },
      { path: project, source: "project" },
    ]);

    expect(result.errors).toEqual([]);
    expect(result.definitions.get("scout")).toMatchObject({
      description: "project scout",
      source: "project",
    });
    expect(result.definitions.get("helper")?.source).toBe("user");
    expect(result.definitions.get("solo")?.source).toBe("builtin");
  });

  it("collects invalid files as errors and keeps loading the rest", () => {
    const dir = tempDir();

    writeAgent(dir, "ok.md", agentFile("ok", "fine"));
    writeAgent(dir, "broken.md", `---\nname: broken\nlimit: 50000\n${lists("")}subagents: []\n---\n`);

    const result = loadDefinitions([{ path: dir, source: "user" }]);

    expect([...result.definitions.keys()]).toEqual(["ok"]);
    expect(result.errors).toEqual([{ path: join(dir, "broken.md"), message: "description is required" }]);
  });

  it("ships the three role agents and general, the agent for work none of them fits", () => {
    const result = loadDefinitions([{ path: join(PACKAGE_ROOT, "agents"), source: "builtin" }]);

    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect([...result.definitions.keys()].sort()).toEqual(["explorer", "general", "implementer", "reviewer"]);
    expect(
      ["explorer", "reviewer", "implementer", "general"].map((name) => {
        const definition = result.definitions.get(name);

        return `${definition?.model}:${definition?.thinking}`;
      }),
    ).toEqual([
      "openai/gpt-6-luna:low",
      "openai/gpt-6-luna:high",
      "openai/gpt-6.1-sol:medium",
      "openai/gpt-6.1-sol:medium",
    ]);

    result.definitions.forEach((definition) => {
      expect(definition.limit).toBeGreaterThanOrEqual(5000);
      expect(definition.worktree).toBe(false);
    });

    const grants = (name: string) => {
      const definition = result.definitions.get(name);

      return [definition?.tools, definition?.skills, definition?.subagents];
    };

    expect(grants("explorer")).toEqual([["read", "grep", "find", "ls"], [], []]);
    expect(grants("reviewer")).toEqual([["read", "grep", "find", "ls", "bash"], [], []]);
    expect(grants("implementer")).toEqual([["read", "grep", "find", "ls", "edit", "write", "bash"], [], []]);
    expect(grants("general")).toEqual(["all", "all", ["explorer", "reviewer"]]);
    expect(result.definitions.get("general")?.description).toMatch(
      /^Use only when no other agent fits the work/,
    );
  });

  it("declares exactly the frontmatter schema's fields in each shipped file, in the schema's order", () => {
    const dir = join(PACKAGE_ROOT, "agents");
    const keys = FRONTMATTER_FIELDS.map((spec) => spec.key);

    readdirSync(dir).forEach((file) => {
      expect(Object.keys(parseFrontmatter(readFileSync(join(dir, file), "utf8")).data)).toEqual(keys);
    });
  });

  it("documents the frontmatter schema in the README table, row by row", () => {
    const readme = readFileSync(join(PACKAGE_ROOT, "README.md"), "utf8");
    const table = readme.slice(readme.indexOf("| Field |")).split("\n\n")[0];

    const rows = Array.from(table.matchAll(/^\| `(\w+)` \| (.*) \| (.*) \| (.*) \|$/gm), (match) => ({
      key: match[1],
      type: match[2],
      required: match[3],
      meaning: match[4],
    }));

    expect(rows.map((row) => row.key)).toEqual(FRONTMATTER_FIELDS.map((spec) => spec.key));

    FRONTMATTER_FIELDS.forEach((spec, index) => {
      const row = rows[index];

      expect(row.required === "required").toBe(spec.required);
      expect(row.type.includes("`all`")).toBe(spec.kind === "list");
      expect(spec.allMeaning === undefined || row.meaning.includes(`\`all\`: ${spec.allMeaning}`)).toBe(true);
    });
  });
});

describe("list fields", () => {
  const head = (lists: Record<string, string>) =>
    Object.entries({ tools: "all", skills: "all", subagents: "[]", ...lists })
      .filter(([, value]) => value !== "")
      .map(([key, value]) => `${key}: ${value}`)
      .join("\n");

  const parse = (lists: Record<string, string>) =>
    parseDefinition(`---\nname: a\ndescription: d\nlimit: 50000\n${head(lists)}\n---\n`, "/x/a.md", "user");

  it.each(["tools", "skills", "subagents"])("fails a file without %s and names the field", (key) => {
    const parsed = parse({ [key]: "" });

    expect(parsed.definition).toBeUndefined();
    expect(parsed.errors).toEqual([
      expect.stringMatching(new RegExp(`^${key} is required \\(.*\\[\\] for none\\)$`)),
    ]);
  });

  it.each(["tools", "skills", "subagents"])("fails a bare %s key with no value as missing", (key) => {
    const bare = parseDefinition(
      `---\nname: a\ndescription: d\nlimit: 50000\n${head({ [key]: "" })}\n${key}:\n---\n`,
      "/x/a.md",
      "user",
    );
    const blank = parse({ [key]: "\n" });

    expect(bare.errors).toEqual([expect.stringMatching(new RegExp(`^${key} is required `))]);
    expect(blank.errors).toEqual([expect.stringMatching(new RegExp(`^${key} is required `))]);
  });

  it.each([
    ["tools", "[-bash]", "-bash"],
    ["tools", "+read, grep", "+read"],
    ["tools", "~", "~"],
    ["tools", "[read, web_*]", "web_*"],
    ["skills", "[docs, ./style]", "./style"],
    ["subagents", "[explorer, -reviewer]", "-reviewer"],
  ])("rejects %s entries that are not plain names", (key, value, shown) => {
    const parsed = parse({ [key]: value });

    expect(parsed.definition).toBeUndefined();
    expect(parsed.errors).toEqual([
      `${key} entries must be plain names of letters, digits, '_' and '-', not starting with '-', got: ${shown}`,
    ]);
  });

  it.each([
    ["tools", "All", "All"],
    ["skills", "[ALL]", "ALL"],
    ["subagents", "[read, All]", "All"],
  ])("takes all only in lowercase for %s", (key, value, shown) => {
    const parsed = parse({ [key]: value });

    expect(parsed.definition).toBeUndefined();
    expect(parsed.errors).toEqual([`${key} takes all in lowercase, got: ${shown}`]);
  });

  it.each(["tools", "skills", "subagents"])("takes %s: [] as none", (key) => {
    expect(parse({ [key]: "[]" }).definition?.[key as "tools"]).toEqual([]);
  });

  it.each(["tools", "skills", "subagents"])("takes %s: all and [all] as everything", (key) => {
    expect(parse({ [key]: "all" }).definition?.[key as "tools"]).toBe("all");
    expect(parse({ [key]: "[all]" }).definition?.[key as "tools"]).toBe("all");
    expect(parse({ [key]: "\n  - all" }).definition?.[key as "tools"]).toBe("all");
  });

  it.each([
    ["tools", "[all, read]", "all, read"],
    ["skills", "all, docs", "all, docs"],
    ["subagents", "[all, all]", "all, all"],
  ])("rejects %s mixing all with names", (key, value, shown) => {
    const parsed = parse({ [key]: value });

    expect(parsed.definition).toBeUndefined();
    expect(parsed.errors).toEqual([`${key} must be all on its own or a list of names, got: ${shown}`]);
  });

  it("keeps listed names as given", () => {
    expect(parse({ tools: "[read, web_fetch]", skills: "docs, git" }).definition).toMatchObject({
      tools: ["read", "web_fetch"],
      skills: ["docs", "git"],
    });
  });

  it("lets subagents: all reach every other agent and never the agent itself", () => {
    const dir = tempDir();

    writeAgent(dir, "lead.md", agentFile("lead", "l", "subagents: all"));
    writeAgent(dir, "worker.md", agentFile("worker", "w", "subagents: [scout]"));
    writeAgent(dir, "scout.md", agentFile("scout", "s"));

    const result = loadDefinitions([{ path: dir, source: "user" }]);

    expect(result.errors).toEqual([]);
    expect(result.definitions.get("lead")?.subagents).toBe("all");
  });

  it("reports a cycle through subagents: all, for two all agents and for an agent that starts an all agent", () => {
    const dir = tempDir();

    writeAgent(dir, "alpha.md", agentFile("alpha", "a", "subagents: all"));
    writeAgent(dir, "beta.md", agentFile("beta", "b", "subagents: all"));

    const pair = loadDefinitions([{ path: dir, source: "user" }]);
    const hint =
      "subagents: all reaches every other agent, so no agent it can reach may start it; list names instead";

    expect(pair.definitions.size).toBe(0);
    expect(pair.errors).toEqual([
      { path: join(dir, "alpha.md"), message: `subagents form a cycle: alpha -> beta -> alpha; ${hint}` },
      { path: join(dir, "beta.md"), message: `subagents form a cycle: beta -> alpha -> beta; ${hint}` },
    ]);

    const other = tempDir();

    writeAgent(other, "lead.md", agentFile("lead", "l", "subagents: all"));
    writeAgent(other, "helper.md", agentFile("helper", "h", "subagents: [lead]"));
    writeAgent(other, "scout.md", agentFile("scout", "s"));

    const chained = loadDefinitions([{ path: other, source: "user" }]);

    expect([...chained.definitions.keys()]).toEqual(["scout"]);
    expect(chained.errors.map((error) => error.message)).toEqual([
      `subagents form a cycle: helper -> lead -> helper; ${hint}`,
      `subagents form a cycle: lead -> helper -> lead; ${hint}`,
    ]);
  });
});

describe("prompt assembly", () => {
  it("appends the base prompt and the agent section, never replacing pi's prompt", () => {
    const parsed = parseDefinition(
      "---\nname: scout\ndescription: d\nlimit: 50000\ntools: all\nskills: all\nsubagents: []\n---\nYou scout.",
      "/x/scout.md",
      "user",
    );

    expect(
      assemblePromptAppend(
        "# Base\nShared rules.\n",
        parsed.definition as NonNullable<typeof parsed.definition>,
      ),
    ).toMatchInlineSnapshot(`
      [
        "# Base
      Shared rules.",
        "# Agent: scout

      You scout.

      Output: your last message is your result. Make it complete and self-contained; your caller sees nothing else.",
      ]
    `);
  });
});

describe("agent-definitions plugin", () => {
  it("loads user and trusted project agents and notifies invalid files", () => {
    const harness = createHarness([agentDefinitionsPlugin]);

    writeAgent(join(harness.host.info.agentDir, "agents"), "mine.md", agentFile("mine", "my agent"));
    writeAgent(join(harness.host.info.agentDir, "agents"), "bad.md", "---\nname: bad\n---\n");
    writeAgent(join(harness.host.info.cwd, ".pi", "agents"), "proj.md", agentFile("proj", "p"));

    harness.host.start();

    const definitions = harness.services.require("definitions");

    expect(definitions.get("mine")?.source).toBe("user");
    expect(definitions.get("proj")).toBeUndefined();
    expect(harness.host.notices.map((notice) => notice.message)).toEqual([
      expect.stringContaining("invalid agent file"),
    ]);
    expect(harness.host.mainPrompt).toBeUndefined();

    harness.host.info.projectTrusted = true;
    harness.host.start();

    expect(definitions.get("proj")?.source).toBe("project");
  });

  it("shows the warnings of a loaded file on session start", () => {
    const { host, root } = createHarness([agentDefinitionsPlugin]);
    const dir = join(root, "agent", "agents");

    writeAgent(dir, "dup.md", agentFile("dup", "d", "subagents: []\ntools: [read, read]"));
    host.start();

    expect(host.notices.map((notice) => notice.message)).toEqual([
      `pi-subagents: agent file ${join(dir, "dup.md")}: tools lists entries more than once: read`,
    ]);
  });
});
