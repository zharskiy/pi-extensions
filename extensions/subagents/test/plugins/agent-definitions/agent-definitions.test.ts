import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseFrontmatter } from "../../../src/plugins/agent-definitions/frontmatter.ts";
import { agentDefinitionsPlugin } from "../../../src/plugins/agent-definitions/index.ts";
import { loadDefinitions, parseDefinition } from "../../../src/plugins/agent-definitions/loader.ts";
import { assemblePromptAppend } from "../../../src/plugins/agent-definitions/prompt.ts";
import { createHarness, PACKAGE_ROOT, tempDir } from "../../helpers/harness.ts";

const writeAgent = (dir: string, file: string, content: string) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), content);
};

const agentFile = (name: string, description: string, extra = "subagents: []", body = "") =>
  `---\nname: ${name}\ndescription: ${description}\nlimit: 50000\n${extra}\n---\n${body}`;

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
        "maxTurns: 12",
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
      maxTurns: 12,
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
  it("accepts comma-separated tools, max_turns and ignores unknown keys", () => {
    const parsed = parseDefinition(
      "---\nname: a\ndescription: d\ntools: read, ls\nmax_turns: 3\ncolor: blue\nlimit: 60000\nsubagents: []\nmodel: openai/gpt-6-luna:low\n---\nDo it.",
      "/x/a.md",
      "user",
    );

    expect(parsed.errors).toEqual([]);
    expect(parsed.definition).toMatchObject({
      name: "a",
      tools: ["read", "ls"],
      maxTurns: 3,
      limit: 60000,
      subagents: [],
      model: "openai/gpt-6-luna",
      thinking: "low",
      prompt: "Do it.",
      input: "task",
      output: "text",
      source: "user",
    });
  });

  it("reports every problem of an invalid file", () => {
    const parsed = parseDefinition(
      "---\nname: bad name\noutput: json\nthinking: high\nlimit: 10\nsubagents: 3\nmodel: gpt 6\nfallback: maybe\n---\n",
      "/x/bad.md",
      "user",
    );

    expect(parsed.definition).toBeUndefined();
    expect(parsed.errors).toEqual(
      expect.arrayContaining([
        "description is required",
        "name may only contain letters, digits, '-' and '_'",
        "output must be one of text, file",
        expect.stringContaining("thinking is no longer a field"),
        "limit must be an integer of at least 5000",
        "subagents must be a list or a comma-separated string",
        'model must be name[:thinking] without spaces, got "gpt 6"',
        "fallback must be true or false",
      ]),
    );
  });

  it("requires limit and subagents", () => {
    const parsed = parseDefinition("---\nname: a\ndescription: d\n---\n", "/x/a.md", "user");

    expect(parsed.definition).toBeUndefined();
    expect(parsed.errors).toEqual([
      "limit is required (context token budget, for example limit: 100000)",
      "subagents is required (agent names it may spawn, or [] for none)",
    ]);
  });

  it("accepts a block list of subagents and treats model inherit as the main session's model", () => {
    const parsed = parseDefinition(
      "---\nname: lead\ndescription: d\nlimit: 80000\nmodel: inherit\nsubagents:\n  - explorer\n  - reviewer\n---\n",
      "/x/lead.md",
      "user",
    );

    expect(parsed.errors).toEqual([]);
    expect(parsed.definition?.subagents).toEqual(["explorer", "reviewer"]);
    expect(parsed.definition?.model).toBeUndefined();
  });
});

describe("model and fallback fields", () => {
  const parse = (extra: string) =>
    parseDefinition(
      `---\nname: a\ndescription: d\nlimit: 50000\nsubagents: []\n${extra}\n---\n`,
      "/x/a.md",
      "user",
    );

  it("accepts a bare model name and a thinking suffix", () => {
    expect(parse("model: haiku:low").definition).toMatchObject({ model: "haiku", thinking: "low" });
    expect(parse("model: openai/gpt-6.1-sol:high").definition).toMatchObject({
      model: "openai/gpt-6.1-sol",
      thinking: "high",
    });
    expect(parse("model: inherit:max").definition).toMatchObject({ model: undefined, thinking: "max" });
  });

  it("keeps a numeric suffix as part of the model id", () => {
    expect(parse("model: amazon-bedrock/claude-haiku-4-5-v1:0").definition?.model).toBe(
      "amazon-bedrock/claude-haiku-4-5-v1:0",
    );
  });

  it("rejects a thinking field and points to the model suffix", () => {
    expect(parse("model: haiku\nthinking: low").errors).toEqual([
      "thinking is no longer a field; put the level on the model as a suffix, for example model: openai/gpt-6-luna:high",
    ]);
  });

  it("rejects an invalid thinking suffix", () => {
    expect(parse("model: haiku:extreme").errors).toEqual([
      expect.stringContaining('model: invalid thinking level "extreme"'),
    ]);
  });

  it("inherits the thinking level when the model has no suffix", () => {
    expect(parse("model: openai/gpt-6.1-sol").definition?.thinking).toBeUndefined();
  });

  it("parses fallback and defaults it to false", () => {
    expect(parse("fallback: true").definition?.fallback).toBe(true);
    expect(parse("").definition?.fallback).toBe(false);
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
    writeAgent(dir, "broken.md", "---\nname: broken\nlimit: 50000\nsubagents: []\n---\n");

    const result = loadDefinitions([{ path: dir, source: "user" }]);

    expect([...result.definitions.keys()]).toEqual(["ok"]);
    expect(result.errors).toEqual([{ path: join(dir, "broken.md"), message: "description is required" }]);
  });

  it("ships the three role agents and the general fallback", () => {
    const result = loadDefinitions([{ path: join(PACKAGE_ROOT, "agents"), source: "builtin" }]);

    expect(result.errors).toEqual([]);
    expect([...result.definitions.keys()].sort()).toEqual(["explorer", "general", "implementer", "reviewer"]);
    expect(result.definitions.get("explorer")?.tools).toEqual(["read", "grep", "find", "ls"]);
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
      expect(definition.model).toMatch(/^openai\//);
      expect(definition.limit).toBeGreaterThanOrEqual(5000);
    });

    const roles = ["explorer", "implementer", "reviewer"].map((name) => result.definitions.get(name));

    expect(roles.map((definition) => [definition?.subagents, definition?.fallback])).toEqual([
      [[], false],
      [[], false],
      [[], false],
    ]);
    expect(result.definitions.get("general")).toMatchObject({
      fallback: true,
      model: "openai/gpt-6.1-sol",
      limit: 100000,
      subagents: ["explorer", "reviewer"],
      tools: ["read", "grep", "find", "ls", "edit", "write", "bash"],
    });
  });
});

describe("prompt assembly", () => {
  it("appends the base prompt and the agent section, never replacing pi's prompt", () => {
    const parsed = parseDefinition(
      "---\nname: scout\ndescription: d\noutput: file\nprompt: Extra rule.\nlimit: 50000\nsubagents: []\n---\nYou scout.",
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

      Extra rule.

      Output: write your full result to the result file path given in your task, then reply with one line naming that path.",
      ]
    `);
  });
});

describe("agent-definitions plugin", () => {
  it("loads user and trusted project agents, notifies invalid files and sets the main session prompt", () => {
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

    const mainPrompt = readFileSync(join(PACKAGE_ROOT, "prompts", "main-session.md"), "utf8").trim();

    expect(harness.host.mainPrompt).toBe(mainPrompt);
    expect(definitions.mainPrompt()).toBe(mainPrompt);
    expect(harness.host.sections.size).toBe(0);

    harness.host.info.projectTrusted = true;
    harness.host.start();

    expect(definitions.get("proj")?.source).toBe("project");
  });
});
