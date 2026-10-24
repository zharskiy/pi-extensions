import { describe, expect, it } from "vitest";
import { createFakeHost } from "../../../test-framework/index.ts";
import { createCommandAliases } from "../api/plugin.ts";

const setup = () => {
  const host = createFakeHost();

  createCommandAliases(host);
  host.start();

  return host;
};

describe("command aliases", () => {
  it("rewrites an exact alias on submit and leaves other text alone", () => {
    const [rewrite] = setup().submitRewrites;

    expect(rewrite("/continue")).toBe("/resume");
    expect(rewrite("  /clear \n")).toBe("/new");
    expect(rewrite("/exit")).toBe("/quit");
    expect(rewrite("/continue now")).toBeUndefined();
    expect(rewrite("continue")).toBeUndefined();
    expect(rewrite("/resume")).toBeUndefined();
    expect(rewrite("__proto__")).toBeUndefined();
  });

  it("maps alias names in slash completion and passes others through", () => {
    const [map] = setup().completionMaps;

    expect(map("/continue")).toBe("/resume");
    expect(map("/clear")).toBe("/new");
    expect(map("/model")).toBeUndefined();
  });

  it("registers every alias as a command that describes its target", () => {
    const host = setup();

    expect(Array.from(host.commands.entries()).map(([name, spec]) => [name, spec.description])).toEqual([
      ["continue", "Alias for /resume"],
      ["clear", "Alias for /new"],
      ["exit", "Alias for /quit"],
    ]);
  });

  it("runs the target through the editor when the alias command still runs", async () => {
    const host = setup();

    await host.runCommand("continue");
    await host.runCommand("exit");

    expect(host.editorSubmissions).toEqual(["/resume", "/quit"]);
    expect(host.notices).toEqual([]);
  });

  it("ignores arguments and submits the target", async () => {
    const host = setup();

    await host.runCommand("continue", "foo");

    expect(host.editorSubmissions).toEqual(["/resume"]);
  });

  it("reports an error when the editor cannot be reached", async () => {
    const host = setup();

    host.editorReachable = false;
    await host.runCommand("clear");

    expect(host.editorSubmissions).toEqual(["/new"]);
    expect(host.notices).toEqual([{ message: "Could not run /new", level: "error" }]);
  });
});
