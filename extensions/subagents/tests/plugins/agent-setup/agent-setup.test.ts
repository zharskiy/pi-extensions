import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { AWAITING_INPUT_CHANNEL } from "../../../../../platform/shared/index.ts";
import { char, type FakeForm, flushMicrotasks, key } from "../../../../../test/framework/index.ts";
import { agentDefinitionsPlugin } from "../../../api/plugins/agent-definitions.ts";
import { agentRegistryPlugin } from "../../../api/plugins/agent-registry.ts";
import { agentSetupPlugin } from "../../../api/plugins/agent-setup.ts";
import { agentViewPlugin } from "../../../api/plugins/agent-view.ts";
import { AUTOSETUP_TYPE } from "../../../core/agent-setup/autosetup.ts";
import {
  CANCELLED,
  NEW_SESSION_HINT,
  NOT_PENDING,
  NOTHING_TO_CHANGE,
  PROPOSAL_TOOL,
  type ProposalParams,
} from "../../../core/agent-setup/proposal.ts";
import { createHarness, tempDir } from "../../support/subagents-harness.ts";

const APPLIES = "agents started from now on use it";

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));

const writeJson = (path: string, value: unknown) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
};

const SEEDED = { agents: { planner: { skills: [] } } };

const setup = ({ trusted = false, seeded = true } = {}) => {
  const harness = createHarness(
    [agentRegistryPlugin, agentDefinitionsPlugin, agentSetupPlugin, agentViewPlugin],
    { overrides: seeded ? SEEDED : {} },
  );
  const { host, runtime, services } = harness;

  host.info.projectTrusted = trusted;
  runtime.skills = ["docs", "search"];

  const projectFile = join(host.info.cwd, ".pi", "pi-subagents.json");
  const userFile = join(host.info.agentDir, "pi-subagents.json");
  const noticesOf = (level: string) =>
    host.notices.filter((notice) => notice.level === level).map((notice) => notice.message);
  const definition = (name: string) => services.require("definitions").get(name);

  const openForm = async () => {
    const run = host.runCommand("agents", "setup");

    await flushMicrotasks();
    host.form().press(char("2"));
    await flushMicrotasks();

    return { run, form: host.form() };
  };

  return { ...harness, projectFile, userFile, noticesOf, definition, openForm };
};

const showsAgent = (form: FakeForm, name: string) =>
  form.render(400).some((line) => line.startsWith(` ${name} `));

const goToAgent = (form: FakeForm, name: string) => {
  Array.from({ length: 20 }).forEach(() => {
    if (!showsAgent(form, name)) {
      form.press(key("tab"));
    }
  });

  expect(showsAgent(form, name)).toBe(true);
};

const goToSubmit = (form: FakeForm) => {
  Array.from({ length: 20 }).forEach(() => {
    if (!form.render(400).some((line) => line.includes("Save to:"))) {
      form.press(key("tab"));
    }
  });

  expect(form.render(400).some((line) => line.includes("Save to:"))).toBe(true);
};

describe("/agents setup form", () => {
  it("writes changed fields into the trusted project's file, keeps other keys and applies them", async () => {
    const { projectFile, openForm, definition, noticesOf } = setup({ trusted: true });

    writeJson(projectFile, { maxConcurrent: 2, agents: { scout: { thinking: "low" } } });

    const { run, form } = await openForm();

    goToAgent(form, "general");
    form.press(key("enter"), key("home"), key("enter"));
    form.press(key("down"), key("enter"), key("home"), key("enter"));
    form.press(key("down"), key("enter"), char("n"), key("space"), key("enter"));
    goToSubmit(form);
    form.press(key("enter"));
    await run;

    expect(form.closed).toBe(true);
    expect(readJson(projectFile)).toEqual({
      maxConcurrent: 2,
      agents: {
        scout: { thinking: "low" },
        general: { model: "inherit", thinking: "off", skills: ["docs"] },
      },
    });
    expect(definition("general")).toMatchObject({ model: undefined, thinking: "off", skills: ["docs"] });
    expect(definition("scout")?.thinking).toBe("low");
    expect(noticesOf("info")).toEqual([
      `pi-subagents: saved general (model, thinking, skills) to ${projectFile}; ${APPLIES}`,
    ]);
  });

  it("shows each skill's description on its row and the full text of the one under the cursor", async () => {
    const { runtime, userFile, openForm } = setup();

    runtime.skills = ["review", "docs", "search"];
    runtime.skillDescriptions = {
      review:
        "Reviews diffs for correctness, missing tests, risky changes and unclear naming, then reports every finding grouped by severity with file and line.",
      docs: "Writes docs",
      search: "Searches the web and cites sources",
    };

    const { run, form } = await openForm();

    goToAgent(form, "general");
    form.press(key("down"), key("down"), key("enter"));

    const lines = form.render(33);
    const list = lines.slice(lines.indexOf(" Skills") + 1);

    expect(list.slice(0, 3)).toEqual([
      " › [ ] review  Reviews diffs f...",
      "   [ ] docs  Writes docs",
      "   [ ] search  Searches the we...",
    ]);
    expect(list.slice(3, 8)).toEqual([
      "",
      " Reviews diffs for correctness,",
      " missing tests, risky changes and",
      " unclear naming, then reports ...",
      "",
    ]);

    form.press(key("down"));
    expect(form.render(33).some((line) => line.startsWith(" Reviews diffs"))).toBe(false);
    expect(form.render(33).some((line) => line.startsWith(" Searches"))).toBe(false);

    form.press(key("down"));
    expect(form.render(33)).toContain(" Searches the web and cites");
    expect(form.render(33)).toContain(" sources");

    form.press(key("space"), key("enter"));
    goToSubmit(form);
    form.press(key("enter"));
    await run;

    expect(readJson(userFile)).toEqual({ agents: { general: { skills: ["search"] } } });
  });

  it("offers only the user file in an untrusted project and writes it", async () => {
    const { projectFile, userFile, openForm, definition } = setup();
    const { run, form } = await openForm();

    goToAgent(form, "scout");
    form.press(key("down"), key("enter"), key("end"), key("enter"));
    goToSubmit(form);
    form.press(key("up"));

    expect(form.render(400).some((line) => line.includes("This project  "))).toBe(false);
    expect(form.render(400).some((line) => line.includes("the user file applies to every project"))).toBe(
      true,
    );

    form.press(key("enter"));
    await run;

    expect(existsSync(projectFile)).toBe(false);
    expect(readJson(userFile)).toEqual({ agents: { scout: { thinking: "max" } } });
    expect(definition("scout")?.thinking).toBe("max");
  });

  it("warns when the trusted project's file sets a field written to the user file", async () => {
    const { projectFile, userFile, openForm, noticesOf } = setup({ trusted: true });

    writeJson(projectFile, { agents: { scout: { thinking: "low" } } });

    const { run, form } = await openForm();

    goToAgent(form, "scout");
    form.press(key("down"), key("enter"), key("end"), key("enter"));
    goToSubmit(form);
    form.press(key("down"), key("enter"));
    await run;

    expect(readJson(userFile)).toEqual({ agents: { scout: { thinking: "max" } } });
    expect(noticesOf("warning")).toContain(
      `pi-subagents: ${projectFile} also sets agents.scout.thinking and wins`,
    );
  });

  it("closes without writing when nothing changed or on Escape", async () => {
    const { projectFile, userFile, openForm, noticesOf } = setup({ trusted: true });
    const first = await openForm();

    first.form.press(key("backTab"), key("enter"));
    await first.run;

    const second = await openForm();

    second.form.press(key("escape"));
    await second.run;

    expect(noticesOf("info")).toEqual(["pi-subagents: nothing changed"]);
    expect(existsSync(projectFile) || existsSync(userFile)).toBe(false);
  });

  it("does not overwrite a settings file that is not valid JSON", async () => {
    const { projectFile, openForm, noticesOf } = setup({ trusted: true });

    writeJson(projectFile, "{ not json");

    const { run, form } = await openForm();

    form.press(key("down"), key("enter"), key("home"), key("enter"), key("backTab"), key("enter"));
    await run;

    expect(readFileSync(projectFile, "utf8")).toBe("{ not json");
    expect(noticesOf("error")).toHaveLength(1);
    expect(noticesOf("error")[0]).toContain(`cannot save ${projectFile}`);
  });

  it("refuses the form outside the terminal UI and names the files to edit", async () => {
    const { host, projectFile, userFile, noticesOf } = setup();

    host.info.mode = "rpc";
    await host.runCommand("agents", "setup");

    expect(host.forms).toEqual([]);
    expect(noticesOf("error")).toHaveLength(1);
    expect(noticesOf("error")[0]).toContain(projectFile);
    expect(noticesOf("error")[0]).toContain(userFile);
  });
});

const autosetup = ({ plain, ...options }: { trusted?: boolean; seeded?: boolean; plain?: boolean } = {}) => {
  const harness = setup({ seeded: false, ...options });
  const { host, runtime } = harness;
  const skillsDir = tempDir();
  const asker = join(skillsDir, "asker", "SKILL.md");

  writeJson(asker, "---\nname: asker\ndescription: Plans\n---\nUse AskUserQuestion before planning.\n");
  runtime.skills = plain ? ["docs", "search"] : ["docs", "search", "asker"];
  runtime.skillPaths = plain ? {} : { asker };

  const propose = (params: ProposalParams) =>
    host.tool<ProposalParams, unknown>(PROPOSAL_TOOL).execute(params, { update: () => {} });

  const awaiting = () =>
    host.published
      .filter((entry) => entry.channel === AWAITING_INPUT_CHANNEL)
      .map((entry) => (entry.data as { waiting: boolean }).waiting);

  return { ...harness, propose, awaiting };
};

const noticesWithHint = (notices: { message: string }[]) =>
  notices.filter((notice) => notice.message.includes("/new"));

const REVIEWER_PROPOSAL: ProposalParams = {
  project: "A TypeScript library",
  assignments: [{ lead: "reviewer", skills: ["search", "docs", "search"] }],
  reasons: [{ skill: "search", why: "finds prior art" }],
};

describe("/agents setup autosetup", () => {
  it("briefs the main session about the leads at once when no agent has a skills override", async () => {
    const { host, noticesOf } = autosetup();

    await host.runCommand("agents", "setup");

    expect(host.forms).toEqual([]);
    expect(host.hidden).toHaveLength(1);
    expect(host.hidden[0]?.message.customType).toBe(AUTOSETUP_TYPE);

    const brief = host.hidden[0]?.message.text ?? "";

    expect(brief).toContain("- reviewer: ");
    expect(brief).toContain("- implementer: ");
    expect(brief).not.toContain("- general: ");
    expect(brief).not.toContain("- scout: ");
    expect(brief).toContain("- docs (no description)");
    expect(brief).not.toContain("asker");
    expect(brief).not.toContain("{{");
    expect(noticesOf("info")).toEqual(["pi-subagents: left out as interactive: asker"]);
  });

  it("sends the brief without a notice when no skill is left out", async () => {
    const { host, noticesOf } = autosetup({ plain: true });

    await host.runCommand("agents", "setup");

    expect(host.hidden).toHaveLength(1);
    expect(host.notices).toEqual([]);
    expect(noticesOf("info")).toEqual([]);
  });

  it("asks first when an override exists, with nothing focused", async () => {
    const { host } = autosetup({ seeded: true });
    const run = host.runCommand("agents", "setup");

    await flushMicrotasks();

    const choice = host.form();

    expect(choice.render(80).some((line) => line.includes("Propose skills automatically"))).toBe(true);
    expect(choice.render(80).some((line) => line.includes("›"))).toBe(false);

    choice.press(key("enter"));
    expect(choice.closed).toBe(false);

    choice.press(key("down"), key("enter"));
    await run;

    expect(host.hidden).toHaveLength(1);
    expect(host.forms).toHaveLength(1);
  });

  it("does nothing on Escape at the question", async () => {
    const { host, noticesOf } = autosetup({ seeded: true });
    const run = host.runCommand("agents", "setup");

    await flushMicrotasks();
    host.form().press(key("escape"));
    await run;

    expect(host.hidden).toEqual([]);
    expect(host.forms).toHaveLength(1);
    expect(noticesOf("info")).toEqual([]);
  });

  it("does not count an override in an untrusted project's file", async () => {
    const { host, projectFile, services } = autosetup();

    writeJson(projectFile, { agents: { reviewer: { skills: ["docs"] } } });
    services.require("definitions").reload();
    await host.runCommand("agents", "setup");

    expect(host.hidden).toHaveLength(1);
  });

  it("sends nothing outside the terminal UI", async () => {
    const { host, noticesOf } = autosetup();

    host.info.mode = "rpc";
    await host.runCommand("agents", "setup");

    expect(host.hidden).toEqual([]);
    expect(noticesOf("error")).toHaveLength(1);
  });
});

describe("agent_skills_proposal", () => {
  it("refuses when no proposal is pending", async () => {
    const { propose, host } = autosetup();
    const result = await propose(REVIEWER_PROPOSAL);

    expect(result).toEqual({ text: NOT_PENDING, isError: true });
    expect(host.forms).toEqual([]);
  });

  it("refuses non-leads, unknown or interactive skills and long lists, keeping the proposal pending", async () => {
    const { host, propose } = autosetup({ trusted: true });

    await host.runCommand("agents", "setup");

    const refused = await propose({
      project: "x",
      assignments: [
        { lead: "general", skills: ["docs"] },
        { lead: "scout", skills: ["docs"] },
        { lead: "nobody", skills: [] },
        { lead: "planner", skills: ["asker", "ghost"] },
        { lead: "reviewer", skills: ["docs", "search", "a", "b", "c", "d"] },
      ],
      reasons: [],
    });

    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("general is not set up here");
    expect(refused.text).toContain("scout is not set up here");
    expect(refused.text).toContain('no agent named "nobody"');
    expect(refused.text).toContain('"asker" asks the user; agents cannot use it');
    expect(refused.text).toContain('no skill named "ghost" here');
    expect(refused.text).toContain("reviewer: at most 5 skills");
    expect(refused.text).not.toContain("chore");
    expect(host.forms).toEqual([]);

    const corrected = propose(REVIEWER_PROPOSAL);

    await flushMicrotasks();
    expect(host.forms).toHaveLength(1);

    host.form().press(key("escape"));

    expect(await corrected).toEqual({ text: CANCELLED });
    expect(await propose(REVIEWER_PROPOSAL)).toEqual({ text: NOT_PENDING, isError: true });
  });

  it("opens the form with the proposal and saves the leads' lists in the proposed order", async () => {
    const { host, propose, projectFile, definition, noticesOf, awaiting } = autosetup({ trusted: true });

    await host.runCommand("agents", "setup");

    const result = propose(REVIEWER_PROPOSAL);

    await flushMicrotasks();

    const form = host.form();

    goToAgent(form, "reviewer");
    expect(
      form.render(400).some((line) => line.includes("Proposed:") && line.includes("finds prior art")),
    ).toBe(true);
    expect(form.render(400).some((line) => line.includes("(changed)"))).toBe(true);
    expect(awaiting()).toEqual([true]);

    goToSubmit(form);
    expect(
      form.render(400).some((line) => line.includes("Project:") && line.includes("TypeScript library")),
    ).toBe(true);
    form.press(key("enter"));

    const { text, isError } = await result;

    expect(isError).toBeUndefined();
    expect(text).toContain(`Saved to ${projectFile}: reviewer skills [search, docs].`);
    expect(text).toContain(NEW_SESSION_HINT);
    expect(text).toContain("/new");
    expect(readJson(projectFile)).toEqual({ agents: { reviewer: { skills: ["search", "docs"] } } });
    expect(definition("reviewer")?.skills).toEqual(["search", "docs"]);
    expect(awaiting()).toEqual([true, false]);
    expect(noticesOf("info").filter((message) => message.includes("saved"))).toEqual([]);
  });

  it("opens no form when the proposal changes nothing", async () => {
    const { host, propose } = autosetup();

    await host.runCommand("agents", "setup");

    const result = await propose({
      project: "x",
      assignments: [{ lead: "reviewer", skills: [] }],
      reasons: [],
    });

    expect(result).toEqual({ text: NOTHING_TO_CHANGE });
    expect(host.forms).toEqual([]);
    expect(noticesWithHint(host.notices)).toEqual([]);
  });

  it("forgets the pending proposal when the session starts again", async () => {
    const { host, propose } = autosetup();

    await host.runCommand("agents", "setup");
    host.start();

    expect(await propose(REVIEWER_PROPOSAL)).toEqual({ text: NOT_PENDING, isError: true });
  });
});

describe("/agents setup one-line form", () => {
  it("sets fields of one agent in the user file and applies them", async () => {
    const { host, userFile, definition } = setup();

    await host.runCommand("agents", "setup scout thinking=high skills=none scope=user");

    expect(readJson(userFile)).toEqual({ agents: { scout: { thinking: "high", skills: [] } } });
    expect(definition("scout")?.thinking).toBe("high");
  });

  it("writes the user file by default in an untrusted project", async () => {
    const { host, userFile, definition } = setup();

    await host.runCommand("agents", "setup scout thinking=low");

    expect(readJson(userFile)).toEqual({ agents: { scout: { thinking: "low" } } });
    expect(definition("scout")?.thinking).toBe("low");
  });

  it("writes the trusted project's file by default with the model and its thinking suffix", async () => {
    const { host, projectFile, definition } = setup({ trusted: true });

    await host.runCommand("agents", "setup scout model=fake/model:low skills=docs,search");

    expect(readJson(projectFile)).toEqual({
      agents: { scout: { model: "fake/model", thinking: "low", skills: ["docs", "search"] } },
    });
    expect(definition("scout")).toMatchObject({ model: "fake/model", thinking: "low" });
  });

  it("reports bad requests and writes nothing", async () => {
    const { host, projectFile, userFile, noticesOf } = setup();
    const requests = [
      "setup nobody thinking=high",
      "setup scout thinking=extreme scope=user",
      "setup scout skills=ghost scope=user",
      "setup scout model=locked/lyra-9-0 scope=user",
      "setup scout color=blue scope=user",
      "setup scout",
      "setup scout thinking=high scope=project",
    ];

    await requests.reduce<Promise<void>>(
      (chain, request) => chain.then(() => host.runCommand("agents", request)),
      Promise.resolve(),
    );

    expect(noticesOf("error")).toHaveLength(requests.length);
    expect(noticesOf("error").at(-1)).toContain("not trusted");
    expect(existsSync(projectFile) || existsSync(userFile)).toBe(false);
  });
});

describe("/agents setup completion", () => {
  it("offers setup as a subcommand and agent names after it", () => {
    const { host } = setup();
    const complete = host.commands.get("agents")?.complete;

    expect(complete?.("se")?.map((entry) => entry.value)).toEqual(["setup"]);
    expect(complete?.("setup sc")?.map((entry) => entry.value)).toEqual(["setup scout"]);
  });
});
