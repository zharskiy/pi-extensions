import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { fixtureMcpServerPath, hiddenMessageTexts } from "../../../../test-framework/index.ts";
import { sessionFacts } from "../../../../test-framework/pi/index.ts";
import { describeLive, realContextMarkers } from "../../../../test-framework/pi/live/index.ts";
import { createLiveHarness, type LiveHarness } from "../support/live-harness.ts";

const code = () => randomUUID().slice(0, 8);

const SKILL_CODES = { alpha: code(), beta: code(), gamma: code() };

const MCP_CODE = code();

const skill = (name: string, body: string) =>
  `---\nname: ${name}\ndescription: Use when asked for the ${name} code word.\n---\n${body}\n`;

type CodemodeResult = { details?: { calls?: { name?: string; status?: string }[] } };

const codemodeCalls = (results: ReturnType<typeof sessionFacts>["results"]) =>
  results
    .filter((result) => result.toolName === "codemode")
    .flatMap((result) => (result.details as CodemodeResult["details"])?.calls ?? [])
    .filter((call) => call.status === "ok")
    .map((call) => call.name ?? "tool");

describeLive("live grants", () => {
  let live: LiveHarness;

  const sessionOf = (id: string) => {
    const record = live.registry.get(id);
    const file = record?.sessionFile ?? "";
    const facts = sessionFacts(file);
    const payload = JSON.stringify(live.runtime.readSession(file).providerPayload);

    return {
      record,
      tools: facts.tools.toSorted(),
      skills: Object.keys(SKILL_CODES).filter((name) => payload.includes(`${name}/SKILL.md`)),
      calls: [...facts.calls, ...codemodeCalls(facts.results)],
      payload,
      leaks: realContextMarkers().filter((marker) => payload.includes(marker)),
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
          from: "scout",
          fields: { tools: "[read, ls]", skills: "[alpha, gamma]", mcp: "true" },
        },
        bare: { from: "scout", fields: { tools: "[]", skills: "[]", mcp: "true" } },
        "all-skills": { from: "scout", fields: { tools: "[read, ls]", skills: "all", mcp: "true" } },
      },
    });

    const config = {
      mcpServers: {
        fixture: { command: process.execPath, args: [fixtureMcpServerPath, MCP_CODE], exposure: "direct" },
      },
    };

    mkdirSync(join(live.project, ".pi"), { recursive: true });
    writeFileSync(join(live.project, ".pi", "mcp.json"), JSON.stringify(config));
  });

  afterAll(async () => {
    await live?.close();
  });

  it("gives tools: [read, ls] and skills: [alpha, gamma] only those, plus handoff, every MCP tool, codemode and tool search", async () => {
    const id = await live.run(
      "granted",
      "In one turn, in parallel: read the alpha and gamma skill files, list your current working directory with ls, call mcp__fixture__code, and create out.txt in your current working directory with the write tool if you have one. Then reply with both skills' code words and the MCP code, nothing else.",
    );

    await live.waitForWakes(1);

    const { record, tools, skills, calls, payload, leaks } = sessionOf(id);

    expect(record?.state).toBe("done");
    expect(leaks).toEqual([]);
    expect(tools).toEqual(["codemode", "handoff", "ls", "mcp__fixture__code", "read", "tool_search"]);
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

  it("gives tools: [] and skills: [] only the handoff tool, no skill and no MCP tool", async () => {
    const before = hiddenMessageTexts(live.host).length;
    const id = await live.run("bare", "Reply with the alpha code word, or NONE if you do not know it.");

    await live.waitForWakes(before + 1);

    const { record, tools, skills, calls, payload } = sessionOf(id);

    expect(record?.state).toBe("done");
    expect(tools).toEqual(["handoff"]);
    expect(skills).toEqual([]);
    expect(calls).toEqual([]);
    expect(payload).not.toContain("mcp__");
    expect(payload).not.toContain("alpha/SKILL.md");
    expect(record?.resultText).not.toContain(SKILL_CODES.alpha);
  });

  it("gives skills: all every main session skill", async () => {
    const before = hiddenMessageTexts(live.host).length;
    const id = await live.run("all-skills", "Reply with the single word OK. Do not call any tool.");

    await live.waitForWakes(before + 1);

    const { record, tools, skills, payload, leaks } = sessionOf(id);

    expect(record?.state).toBe("done");
    expect(leaks).toEqual([]);
    expect(tools).toEqual(["codemode", "handoff", "ls", "mcp__fixture__code", "read", "tool_search"]);
    expect(skills).toEqual(["alpha", "beta", "gamma"]);
    expect(payload).toContain("mcp__fixture__code");
    expect(payload).not.toContain('"write"');
    expect(payload).not.toContain('"edit"');
    expect(payload).not.toContain('"bash"');
  });
});
