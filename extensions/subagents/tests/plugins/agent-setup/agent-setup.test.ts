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

const skillsTop = (lines: string[]) => lines.findIndex((line) => line.startsWith(" Skills  "));

const showsAgent = (form: FakeForm, name: string) => form.render(400).includes(` ${name}`);

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
    form.press(key("down"), key("enter"), key("down"), key("space"), key("enter"));
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
    expect(existsSync(join(dirname(projectFile), ".gitignore"))).toBe(false);
  });

  it("shows each skill's description on its row and two rows of the one under the cursor", async () => {
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
    form.press(key("down"), key("down"), key("enter"), key("down"));

    const lines = form.render(33);
    const list = lines.slice(skillsTop(lines) + 1);

    expect(list.slice(0, 5)).toEqual([
      "",
      "   [x] all  every skill of the...",
      " › [ ] review  Reviews diffs f...",
      "   [ ] docs  Writes docs",
      "   [ ] search  Searches the we...",
    ]);

    const height = lines.length;
    const details = [
      " Reviews diffs for correctness,",
      " missing tests, risky changes ...",
      " Writes docs",
      " Searches the web and cites",
      " sources",
    ];
    const shown = (rendered: string[]) => {
      expect(rendered).toHaveLength(height);

      return details.filter((text) => rendered.includes(text));
    };

    expect(shown(lines)).toEqual(details.slice(0, 2));

    form.press(key("down"));
    expect(shown(form.render(33))).toEqual([" Writes docs"]);

    form.press(key("down"));
    expect(shown(form.render(33))).toEqual(details.slice(3));

    form.press(key("home"));
    expect(shown(form.render(33))).toEqual([]);

    form.press(key("end"));
    form.press(key("space"), key("enter"));
    goToSubmit(form);
    form.press(key("enter"));
    await run;

    expect(readJson(userFile)).toEqual({ agents: { general: { skills: ["search"] } } });
  });

  it("groups leads before chores, shipped before own, each by name", async () => {
    const { host, userFile, openForm, services } = setup();
    const agents = join(host.info.agentDir, "agents");
    const agentFile = (name: string, subagents: string) =>
      `---\nname: ${name}\ndescription: Own ${name}.\nlimit: 100000\ntools: []\nskills: []\nsubagents: ${subagents}\n---\nWork.\n`;

    writeJson(join(agents, "aardvark.md"), agentFile("aardvark", "[scout]"));
    writeJson(join(agents, "abacus.md"), agentFile("abacus", "[]"));
    writeJson(userFile, SEEDED);
    services.require("definitions").reload();

    const { form } = await openForm();
    const bar = form.render(400).slice(1, 3);

    expect(bar[0]).toBe(" Leads   □ general  □ implementer  □ planner  □ reviewer  □ aardvark");
    expect(bar[1]).toBe(
      " Chores  □ editor  □ fetch  □ image  □ scout  □ shell  □ verifier  □ abacus  ✓ Submit",
    );

    const order = [
      ...["general", "implementer", "planner", "reviewer", "aardvark"],
      ...["editor", "fetch", "image", "scout", "shell", "verifier", "abacus"],
    ];
    const visited = order.map(() => {
      const shown = order.find((name) => showsAgent(form, name));

      form.press(key("tab"));

      return shown;
    });

    expect(visited).toEqual(order);
  });

  it("sets general to a subset of skills and back to all", async () => {
    const { userFile, openForm, definition } = setup();
    const first = await openForm();

    goToAgent(first.form, "general");
    first.form.press(key("down"), key("down"), key("enter"), key("down"), key("space"), key("enter"));
    goToSubmit(first.form);
    first.form.press(key("enter"));
    await first.run;

    expect(readJson(userFile)).toEqual({ agents: { general: { skills: ["docs"] } } });
    expect(definition("general")?.skills).toEqual(["docs"]);

    const second = await openForm();

    goToAgent(second.form, "general");
    second.form.press(key("down"), key("down"), key("enter"), key("space"), key("enter"));
    goToSubmit(second.form);
    second.form.press(key("enter"));
    await second.run;

    expect(readJson(userFile)).toEqual({ agents: { general: { skills: "all" } } });
    expect(definition("general")?.skills).toBe("all");
  });

  it("offers only the user file in an untrusted project and writes it", async () => {
    const { projectFile, userFile, openForm, definition } = setup();
    const { run, form } = await openForm();

    goToAgent(form, "scout");
    form.press(key("down"), key("enter"), key("end"), key("enter"));
    goToSubmit(form);
    form.press(key("up"));

    expect(form.render(400).some((line) => line.includes("This project  "))).toBe(false);
    expect(
      form.render(400).some((line) => line.includes("only the user file applies, to every project")),
    ).toBe(true);

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

const autosetup = (options: { trusted?: boolean; seeded?: boolean } = {}) => {
  const harness = setup({ seeded: false, ...options });
  const { host, runtime } = harness;
  const skillsDir = tempDir();
  const asker = join(skillsDir, "asker", "SKILL.md");

  writeJson(asker, "---\nname: asker\ndescription: Plans\n---\nUse AskUserQuestion before planning.\n");
  runtime.skills = ["docs", "search", "asker"];
  runtime.skillPaths = { asker };

  const propose = (params: ProposalParams) =>
    host.tool<ProposalParams, unknown>(PROPOSAL_TOOL).execute(params, {});

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
    const { host } = autosetup();

    await host.runCommand("agents", "setup");

    expect(host.forms).toEqual([]);
    expect(host.hidden).toHaveLength(1);
    expect(host.hidden[0]?.message.customType).toBe(AUTOSETUP_TYPE);

    const brief = host.hidden[0]?.message.text ?? "";

    expect(brief).toContain("- reviewer: ");
    expect(brief).toContain("- implementer: ");
    expect(brief).toContain("- general: ");
    expect(brief).not.toContain("- scout: ");
    expect(brief).toContain("- docs (no description)");
    expect(brief).not.toContain("asker");
    expect(brief).not.toContain("{{");
    expect(host.notices).toEqual([]);
  });

  it("asks first when an override exists, with Yes selected so Enter starts autosetup", async () => {
    const { host } = autosetup({ seeded: true });
    const run = host.runCommand("agents", "setup");

    await flushMicrotasks();

    const choice = host.form();

    expect(choice.render(80).some((line) => line.includes("Propose skills automatically"))).toBe(true);
    expect(choice.render(80).some((line) => line.includes("› 1. Yes"))).toBe(true);

    choice.press(key("enter"));
    await run;

    expect(host.hidden).toHaveLength(1);
    expect(host.forms).toHaveLength(1);
  });

  it("opens the plain form on 2 or on moving down and Enter", async () => {
    const digit = autosetup({ seeded: true });
    const moved = autosetup({ seeded: true });
    const digitRun = digit.host.runCommand("agents", "setup");
    const movedRun = moved.host.runCommand("agents", "setup");

    await flushMicrotasks();
    digit.host.form().press(char("2"));
    moved.host.form().press(key("down"), key("enter"));
    await flushMicrotasks();

    expect(digit.host.hidden).toEqual([]);
    expect(digit.host.forms).toHaveLength(2);
    expect(moved.host.hidden).toEqual([]);
    expect(moved.host.forms).toHaveLength(2);

    digit.host.form().press(key("escape"));
    moved.host.form().press(key("escape"));
    await Promise.all([digitRun, movedRun]);
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

  it("briefs at once when the only skills override is on a chore", async () => {
    const { host, userFile, services } = autosetup();

    writeJson(userFile, { agents: { scout: { skills: ["docs"] } } });
    services.require("definitions").reload();
    await host.runCommand("agents", "setup");

    expect(host.forms).toEqual([]);
    expect(host.hidden).toHaveLength(1);
  });

  it("asks first when general has a skills override and briefs its overridden list", async () => {
    const { host, userFile, services } = autosetup();

    writeJson(userFile, { agents: { general: { skills: ["docs"] } } });
    services.require("definitions").reload();

    const run = host.runCommand("agents", "setup");

    await flushMicrotasks();
    host.form().press(key("enter"));
    await run;

    expect(host.forms).toHaveLength(1);
    expect(host.hidden).toHaveLength(1);
    expect(host.hidden[0]?.message.text).toMatch(/^- general: .* \| skills: docs$/m);
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
    expect(refused.text).not.toContain("general is not set up here");
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
    expect(form.render(400).some((line) => line.includes("Suggested") && line.endsWith("(in use)"))).toBe(
      true,
    );
    expect(awaiting()).toEqual([true]);

    goToSubmit(form);
    expect(form.render(400)).toContain(" reviewer: skills search, docs (suggested) (was none)");
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

    await host.runCommand("agents", "setup reviewer thinking=high skills=none scope=user");

    expect(readJson(userFile)).toEqual({ agents: { reviewer: { thinking: "high", skills: [] } } });
    expect(definition("reviewer")?.thinking).toBe("high");
  });

  it("writes the user file by default in an untrusted project", async () => {
    const { host, userFile, definition } = setup();

    await host.runCommand("agents", "setup scout thinking=low");

    expect(readJson(userFile)).toEqual({ agents: { scout: { thinking: "low" } } });
    expect(definition("scout")?.thinking).toBe("low");
  });

  it("writes the trusted project's file by default with the model and its thinking suffix", async () => {
    const { host, projectFile, definition } = setup({ trusted: true });

    await host.runCommand("agents", "setup reviewer model=fake/model:low skills=docs,search");

    expect(readJson(projectFile)).toEqual({
      agents: { reviewer: { model: "fake/model", thinking: "low", skills: ["docs", "search"] } },
    });
    expect(definition("reviewer")).toMatchObject({ model: "fake/model", thinking: "low" });
    expect(readFileSync(join(dirname(projectFile), ".gitignore"), "utf8")).toBe("*\n");
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
      "setup scout skills=docs scope=user",
    ];

    await requests.reduce<Promise<void>>(
      (chain, request) => chain.then(() => host.runCommand("agents", request)),
      Promise.resolve(),
    );

    expect(noticesOf("error")).toHaveLength(requests.length);
    expect(noticesOf("error").at(-2)).toContain("not trusted");
    expect(noticesOf("error").at(-1)).toBe(
      "pi-subagents: scout is a chore; /agents setup changes only its model and thinking",
    );
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
