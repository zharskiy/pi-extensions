import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentDefinitionsPlugin } from "../../../api/plugins/agent-definitions.ts";
import { FRONTMATTER_FIELDS } from "../../../core/agent-definitions/fields.ts";
import {
  loadDefinitions,
  type OverrideCheck,
  parseDefinition,
} from "../../../core/agent-definitions/loader.ts";
import { assemblePromptAppend } from "../../../core/agent-definitions/prompt.ts";
import { parseFrontmatter } from "../../../core/agent-definitions/yaml-lite.ts";
import { createHarness, PACKAGE_ROOT, tempDir } from "../../support/subagents-harness.ts";

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
      "---\nname: bad name\nthinking: high\nlimit: 10\nsubagents: 3\nmodel: nova 6\nworktree: maybe\n---\n",
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
        'model must be name[:thinking] without spaces, got "nova 6"',
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
      "skills is required (skill names, all for every skill of the agent's caller, or [] for none)",
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
      "---\nname: lead\ndescription: d\nlimit: 80000\nmodel: inherit\ntools: all\nskills: all\nsubagents:\n  - scout\n  - reviewer\n---\n",
      "/x/lead.md",
      "user",
    );

    expect(parsed.errors).toEqual([]);
    expect(parsed.definition?.subagents).toEqual(["scout", "reviewer"]);
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

describe("mcp field", () => {
  const parse = (extra: string) =>
    parseDefinition(agentFile("a", "d", `subagents: []\n${extra}`), "/x/a.md", "user");

  it("is a known field, omitted by default, and accepts a boolean", () => {
    expect(parse("").definition?.mcp).toBeUndefined();
    expect(parse("mcp: true").warnings).toEqual([]);
    expect(parse("mcp: true").definition?.mcp).toBe(true);
    expect(parse("mcp: false").definition?.mcp).toBe(false);
  });

  it("rejects anything but a boolean", () => {
    expect(parse("mcp: some").errors).toEqual(["mcp must be true or false"]);
  });
});

describe("agent overrides", () => {
  const dirs = () => {
    const root = tempDir();
    const shipped = join(root, "shipped");
    const user = join(root, "user");

    const fields = "subagents: []\nmodel: acme/one:low";

    writeAgent(shipped, "a.md", agentFile("a", "shipped", `${fields}\nskills: [docs]`));
    writeAgent(shipped, "b.md", agentFile("b", "shipped b", fields));

    return {
      root,
      list: [
        { path: shipped, source: "builtin" as const },
        { path: user, source: "user" as const },
      ],
      user,
    };
  };

  const check = (
    overrides: OverrideCheck["overrides"],
    extra: Partial<OverrideCheck> = {},
  ): OverrideCheck => ({
    overrides,
    skillNames: () => ["docs", "git"],
    modelProblem: (model) => (model.startsWith("acme/") ? undefined : "matches no available model"),
    ...extra,
  });

  it("applies the override field by field on whichever file won", () => {
    const { list, user } = dirs();

    writeAgent(user, "a.md", agentFile("a", "user", "subagents: []\nmodel: acme/two:high\nskills: [git]"));

    const result = loadDefinitions(list, check({ a: { thinking: "medium" }, b: { skills: ["git"] } }));

    expect(result.notices).toEqual([]);
    expect(result.definitions.get("a")).toMatchObject({
      description: "user",
      model: "acme/two",
      thinking: "medium",
      skills: ["git"],
    });
    expect(result.definitions.get("b")).toMatchObject({
      model: "acme/one",
      thinking: "low",
      skills: ["git"],
    });
  });

  it("replaces model and skills, keeps the file's thinking, and clears the model for inherit", () => {
    const { list } = dirs();

    const result = loadDefinitions(
      list,
      check({ a: { model: "acme/three", skills: [] }, b: { model: "inherit", thinking: "off" } }),
    );

    expect(result.definitions.get("a")).toMatchObject({ model: "acme/three", thinking: "low", skills: [] });
    expect(result.definitions.get("b")).toMatchObject({ model: undefined, thinking: "off" });
  });

  it("warns about a model or skills that fail the check and drops only that field", () => {
    const { list } = dirs();

    const result = loadDefinitions(
      list,
      check({ a: { model: "other/x", thinking: "high", skills: ["docs", "lint"] } }),
    );

    expect(result.definitions.get("a")).toMatchObject({
      model: "acme/one",
      thinking: "high",
      skills: ["docs"],
    });
    expect(result.notices).toEqual([
      { level: "warning", message: 'agents.a.model "other/x": matches no available model; dropped' },
      {
        level: "warning",
        message: "agents.a.skills names unknown skill(s) lint (available skills: docs, git); dropped",
      },
    ]);
  });

  it("warns about unknown skills an agent file names and keeps the definition, unless an override replaces them", () => {
    const { list, user } = dirs();

    writeAgent(user, "a.md", agentFile("a", "user", "subagents: []\nskills: [docs, lint]"));
    writeAgent(user, "b.md", agentFile("b", "user b", "subagents: []\nskills: [lint]"));

    const result = loadDefinitions(list, check({ b: { skills: ["git"] } }));

    expect(result.definitions.get("a")).toMatchObject({ skills: ["docs", "lint"] });
    expect(result.definitions.get("b")).toMatchObject({ skills: ["git"] });
    expect(result.notices).toEqual([]);
    expect(result.warnings).toEqual([
      {
        path: join(user, "a.md"),
        message: "skills names unknown skill(s) lint (available skills: docs, git); those are not loaded",
      },
    ]);
  });

  it("warns about an unknown agent and only informs about one defined in an untrusted project", () => {
    const { list, root } = dirs();
    const untrusted = join(root, "project-agents");

    writeAgent(untrusted, "local.md", agentFile("local", "untrusted"));

    const result = loadDefinitions(
      list,
      check({ ghost: { thinking: "low" }, local: {} }, { untrustedDir: untrusted }),
    );

    expect(result.definitions.has("local")).toBe(false);
    expect(result.notices).toEqual([
      { level: "warning", message: 'agents.ghost: no agent named "ghost"; override ignored' },
      {
        level: "info",
        message:
          'agents.local: "local" is defined only in this project\'s .pi/agents, which is not trusted; override not applied',
      },
    ]);
  });

  it("checks nothing and leaves definitions alone without overrides", () => {
    const { list } = dirs();
    const result = loadDefinitions(list);

    expect(result.notices).toEqual([]);
    expect(result.definitions.get("a")).toMatchObject({
      model: "acme/one",
      thinking: "low",
      skills: ["docs"],
    });
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

  it("reads agent files in subfolders and warns about a name defined twice in one location", () => {
    const root = tempDir();
    const builtin = join(root, "builtin");
    const user = join(root, "user");

    writeAgent(join(builtin, "chores"), "scout.md", agentFile("scout", "builtin scout"));
    writeAgent(join(user, "team", "nested"), "helper.md", agentFile("helper", "nested helper"));
    writeAgent(join(user, "a"), "one.md", agentFile("twin", "first twin"));
    writeAgent(join(user, "b"), "two.md", agentFile("twin", "second twin"));
    writeAgent(join(user, "b"), "notes.txt", "not an agent");

    const result = loadDefinitions([
      { path: builtin, source: "builtin" },
      { path: user, source: "user" },
    ]);

    expect(result.errors).toEqual([]);
    expect([...result.definitions.keys()].sort()).toEqual(["helper", "scout", "twin"]);
    expect(result.definitions.get("scout")?.path).toBe(join(builtin, "chores", "scout.md"));
    expect(result.definitions.get("helper")?.path).toBe(join(user, "team", "nested", "helper.md"));
    expect(result.definitions.get("twin")?.description).toBe("second twin");
    expect(result.warnings).toEqual([
      {
        path: join(user, "b", "two.md"),
        message: `agent "twin" is also defined in ${join(user, "a", "one.md")}; this file wins`,
      },
    ]);
  });

  it("collects invalid files as errors and keeps loading the rest", () => {
    const dir = tempDir();

    writeAgent(dir, "ok.md", agentFile("ok", "fine"));
    writeAgent(dir, "broken.md", `---\nname: broken\nlimit: 50000\n${lists("")}subagents: []\n---\n`);

    const result = loadDefinitions([{ path: dir, source: "user" }]);

    expect([...result.definitions.keys()]).toEqual(["ok"]);
    expect(result.errors).toEqual([{ path: join(dir, "broken.md"), message: "description is required" }]);
  });

  it("ships the ten agents with the design's field order and models", () => {
    const result = loadDefinitions([{ path: join(PACKAGE_ROOT, "agents"), source: "builtin" }]);
    const names = [
      "editor",
      "fetch",
      "general",
      "image",
      "implementer",
      "planner",
      "reviewer",
      "scout",
      "shell",
      "verifier",
    ];
    const folders: Record<string, string> = {
      editor: "chores",
      fetch: "chores",
      general: "leads",
      image: "chores",
      implementer: "leads",
      planner: "leads",
      reviewer: "leads",
      scout: "chores",
      shell: "chores",
      verifier: "chores",
    };
    const fields = [
      "name",
      "description",
      "model",
      "limit",
      "tools",
      "skills",
      "subagents",
      "worktree",
      "mcp",
    ];

    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect([...result.definitions.keys()].sort()).toEqual(names);
    expect(result.definitions.has("explorer")).toBe(false);
    expect(
      readdirSync(join(PACKAGE_ROOT, "agents"), { recursive: true, encoding: "utf8" })
        .filter((file) => file.endsWith(".md"))
        .sort(),
    ).toEqual(names.map((name) => `${folders[name]}/${name}.md`).sort());

    names.forEach((name) => {
      const head = readFileSync(
        join(PACKAGE_ROOT, "agents", folders[name] as string, `${name}.md`),
        "utf8",
      ).split("---")[1] as string;
      const keys = head
        .split("\n")
        .map((line) => /^([a-z]+):/.exec(line)?.[1])
        .filter((key): key is string => key !== undefined);

      expect(keys).toEqual(fields);
    });

    expect(
      [
        "scout",
        "editor",
        "fetch",
        "shell",
        "image",
        "verifier",
        "planner",
        "reviewer",
        "implementer",
        "general",
      ].map((name) => {
        const definition = result.definitions.get(name);

        return `${definition?.model?.replace(/^[^/]+\/.+$/, "provider/id")}:${definition?.thinking}`;
      }),
    ).toEqual([
      "provider/id:low",
      "provider/id:low",
      "provider/id:low",
      "provider/id:low",
      "provider/id:low",
      "provider/id:low",
      "provider/id:high",
      "provider/id:high",
      "provider/id:medium",
      "provider/id:medium",
    ]);

    result.definitions.forEach((definition) => {
      expect(definition.limit).toBeGreaterThanOrEqual(5000);
      expect(definition.worktree).toBe(false);
      expect(definition.mcp).toBe(folders[definition.name] === "leads");
    });

    const grants = (name: string) => {
      const definition = result.definitions.get(name);

      return [definition?.tools, definition?.skills, definition?.subagents];
    };

    expect(grants("scout")).toEqual([["read", "grep", "find", "ls"], [], []]);
    expect(grants("planner")).toEqual([["read", "grep", "find", "ls"], [], ["scout", "shell", "fetch"]]);
    expect(grants("reviewer")).toEqual([["read", "grep", "find", "ls", "bash"], [], ["scout", "shell"]]);
    expect(grants("implementer")).toEqual([
      ["read", "grep", "find", "ls", "edit", "write", "bash"],
      [],
      ["scout", "shell", "verifier"],
    ]);
    expect(grants("fetch")).toEqual([["fetch", "read"], [], []]);
    expect(grants("shell")).toEqual([["bash", "read"], [], []]);
    expect(grants("image")).toEqual([["read"], [], []]);
    expect(grants("verifier")).toEqual([["read", "grep", "find", "ls", "bash"], [], []]);
    expect(grants("editor")).toEqual([["read", "grep", "find", "ls", "edit", "write"], [], []]);
    expect(grants("general")).toEqual([
      "all",
      "all",
      ["scout", "editor", "fetch", "shell", "image", "verifier", "planner", "implementer", "reviewer"],
    ]);
    expect(result.definitions.get("general")?.description).toMatch(/^Use only when no other agent fits/);
  });

  it("declares exactly the frontmatter schema's fields in each shipped file, in the schema's order", () => {
    const dir = join(PACKAGE_ROOT, "agents");
    const keys = FRONTMATTER_FIELDS.map((spec) => spec.key);

    readdirSync(dir, { recursive: true, encoding: "utf8" })
      .filter((file) => file.endsWith(".md"))
      .forEach((file) => {
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
    ["subagents", "[scout, -reviewer]", "-reviewer"],
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

      You scout.",
      ]
    `);
  });

  it("ships a base prompt with the result contract", () => {
    const base = readFileSync(join(PACKAGE_ROOT, "prompts", "base-system-prompt.md"), "utf8");

    expect(base).toContain("Status: done | partial | blocked");
  });

  it("tells the agent that approvals are refused", () => {
    const base = readFileSync(join(PACKAGE_ROOT, "prompts", "base-system-prompt.md"), "utf8");
    const parsed = parseDefinition(
      "---\nname: scout\ndescription: d\nlimit: 50000\ntools: all\nskills: all\nsubagents: []\n---\nYou scout.",
      "/x/scout.md",
      "user",
    );
    const [first] = assemblePromptAppend(base, parsed.definition as NonNullable<typeof parsed.definition>);

    expect(first).toContain("Confirmations are refused at once.");
    expect(first).toContain("list the step under Open");
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

  it("applies settings overrides at session start and reports each failed check once", () => {
    const harness = createHarness([agentDefinitionsPlugin], {
      overrides: {
        agents: {
          scout: { model: "nobody/none", thinking: "high", skills: ["docs"] },
          ghost: { thinking: "low" },
        },
      },
      beforeStart: ({ runtime }) => {
        runtime.skills = ["docs"];
      },
    });

    harness.host.start();

    const scout = harness.services.require("definitions").get("scout");

    expect(scout?.skills).toEqual(["docs"]);
    expect(scout?.thinking).toBe("high");
    expect(scout?.model).not.toBe("nobody/none");
    expect(harness.host.notices).toEqual([
      {
        level: "warning",
        message: expect.stringMatching(
          /^pi-subagents settings: agents\.scout\.model "nobody\/none": .*dropped$/,
        ),
      },
      {
        level: "warning",
        message: 'pi-subagents settings: agents.ghost: no agent named "ghost"; override ignored',
      },
    ]);
  });

  it("only informs about an override for an agent of an untrusted project", () => {
    const harness = createHarness([agentDefinitionsPlugin], {
      overrides: { agents: { proj: { thinking: "low" } } },
      beforeStart: ({ host }) => {
        writeAgent(join(host.info.cwd, ".pi", "agents"), "proj.md", agentFile("proj", "p"));
      },
    });

    expect(harness.host.notices).toEqual([
      {
        level: "info",
        message:
          'pi-subagents settings: agents.proj: "proj" is defined only in this project\'s .pi/agents, which is not trusted; override not applied',
      },
    ]);

    harness.host.info.projectTrusted = true;
    harness.host.start();

    expect(harness.services.require("definitions").get("proj")?.thinking).toBe("low");
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
