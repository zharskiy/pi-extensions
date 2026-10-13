import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { describeLive, realContextMarkers } from "../../../../core/test/adapter/live.ts";
import { wakeTexts } from "../helpers/harness.ts";
import { createLiveHarness, type LiveHarness } from "../helpers/live.ts";

const code = () => randomUUID().slice(0, 8);

const SKILL_CODES = { alpha: code(), beta: code(), gamma: code() };

const MCP_CODE = code();

const FIXTURE = resolve(import.meta.dirname, "fixtures", "mcp-server.ts");

const skill = (name: string, body: string) =>
  `---\nname: ${name}\ndescription: Use when asked for the ${name} code word.\n---\n${body}\n`;

describeLive("live grants", () => {
  let live: LiveHarness;

  const sessionOf = (id: string) => {
    const record = live.registry.get(id);
    const session = live.runtime.readSession(record?.sessionFile ?? "");
    const calls = session.items.flatMap((item) => (item.kind === "assistant" ? item.toolCalls : []));

    return {
      record,
      tools: session.prompt.tools.map((tool) => tool.name).toSorted(),
      skills: session.prompt.skills.map((entry) => entry.name).toSorted(),
      calls: calls.map((call) => call.name),
      payload: JSON.stringify(session.prompt.providerPayload),
      leaks: realContextMarkers().filter((marker) => JSON.stringify(session.prompt).includes(marker)),
    };
  };

  beforeAll(() => {
    live = createLiveHarness("grants", {
      trusted: true,
      skills: Object.fromEntries(
        Object.entries(SKILL_CODES).map(([name, word]) => [name, skill(name, `The code word is ${word}.`)]),
      ),
      agents: {
        granted: {
          from: "explorer",
          fields: { tools: "[read, ls]", skills: "[alpha, gamma]" },
        },
        bare: { from: "explorer", fields: { tools: "[]", skills: "[]" } },
        "all-skills": { from: "explorer", fields: { tools: "[read, ls]", skills: "all" } },
      },
    });

    const config = {
      mcpServers: {
        fixture: { command: process.execPath, args: [FIXTURE, MCP_CODE], exposure: "direct" },
      },
    };

    mkdirSync(join(live.project, ".pi"), { recursive: true });
    writeFileSync(join(live.project, ".pi", "mcp.json"), JSON.stringify(config));
  });

  afterAll(async () => {
    await live?.close();
  });

  it("gives tools: [read, ls] and skills: [alpha, gamma] only those, plus every MCP tool, codemode and tool search", async () => {
    const id = await live.run(
      "granted",
      "In one turn, in parallel: read the alpha and gamma skill files, list your current working directory with ls, call mcp__fixture__code, and create out.txt in your current working directory with the write tool if you have one. Then reply with both skills' code words and the MCP code, nothing else.",
    );

    await live.waitForWakes(1);

    const { record, tools, skills, calls, payload, leaks } = sessionOf(id);

    expect(record?.state).toBe("done");
    expect(leaks).toEqual([]);
    expect(tools).toEqual(["codemode", "ls", "mcp__fixture__code", "read", "tool_search"]);
    expect(skills).toEqual(["alpha", "gamma"]);
    expect(calls).toEqual(expect.arrayContaining(["read", "ls", "mcp__fixture__code"]));
    expect(calls).not.toContain("write");
    expect(payload).not.toContain("beta/SKILL.md");
    expect(payload).not.toContain("the beta code word");
    expect(payload).not.toContain(SKILL_CODES.beta);
    expect(existsSync(join(live.project, "out.txt"))).toBe(false);
    expect(record?.resultText).toContain(SKILL_CODES.alpha);
    expect(record?.resultText).toContain(SKILL_CODES.gamma);
    expect(record?.resultText).toContain(MCP_CODE);
  });

  it("gives tools: [] and skills: [] no tool, no skill and no MCP tool", async () => {
    const before = wakeTexts(live.host).length;
    const id = await live.run("bare", "Reply with the alpha code word, or NONE if you do not know it.");

    await live.waitForWakes(before + 1);

    const { record, tools, skills, calls, payload } = sessionOf(id);

    expect(record?.state).toBe("done");
    expect(tools).toEqual([]);
    expect(skills).toEqual([]);
    expect(calls).toEqual([]);
    expect(payload).not.toContain("mcp__");
    expect(payload).not.toContain("alpha/SKILL.md");
    expect(record?.resultText).not.toContain(SKILL_CODES.alpha);
  });

  it("gives skills: all every main session skill", async () => {
    const before = wakeTexts(live.host).length;
    const id = await live.run("all-skills", "Reply with the single word OK. Do not call any tool.");

    await live.waitForWakes(before + 1);

    const { record, tools, skills, payload, leaks } = sessionOf(id);

    expect(record?.state).toBe("done");
    expect(leaks).toEqual([]);
    expect(tools).toEqual(["codemode", "ls", "mcp__fixture__code", "read", "tool_search"]);
    expect(skills).toEqual(["alpha", "beta", "gamma"]);
    expect(payload).toContain("mcp__fixture__code");
    expect(payload).not.toContain('"write"');
    expect(payload).not.toContain('"edit"');
    expect(payload).not.toContain('"bash"');
  });
});
