import { describe, expect, it } from "vitest";
import { key } from "../../../../../test/framework/index.ts";
import { initialSetup } from "../../../ui/agent-setup/form.ts";
import { context, PATHS, press, proposedContext, render } from "../../support/setup-context.ts";

const EVERY_PROJECT =
  " This project is not trusted, so pi does not read its .pi/pi-subagents.json; the user file applies to every project.";

describe("agent setup rendering", () => {
  it("renders the agent tab with its fields, tools note and MCP line", () => {
    const lines = render(context(), initialSetup(context()));

    expect(lines.slice(1, 3)).toEqual(["Leads   □ lead  □ helper", "Chores  □ chore  ✓ Submit"]);
    expect(lines).toContain(" lead Leads things.");
    expect(lines).toContain(" › Model     acme/big");
    expect(lines).toContain("   Thinking  high");
    expect(lines).toContain("   Skills    all (every skill of the agent's caller)");
    expect(lines.some((line) => line.includes("create your own agent with /agents create."))).toBe(true);
    expect(lines.some((line) => line.startsWith(" MCP: on"))).toBe(true);
  });

  it("renders a chore tab with its skills as a fixed row after model and thinking", () => {
    const ctx = context();
    const lines = render(ctx, press(ctx, initialSetup(ctx), key("tab"), key("tab")).state);

    expect(lines[2]).toBe("Chores  □ chore  ✓ Submit");
    expect(lines.slice(lines.indexOf(" chore Does chores.") + 2).slice(0, 3)).toEqual([
      " › Model     gone/old",
      "   Thinking  default",
      "   Skills    none · fixed for chores",
    ]);
  });

  it("lists the changes and only the user file on the submit tab when untrusted, saying it applies everywhere", () => {
    const ctx = context(false);
    const edited = press(ctx, initialSetup(ctx), key("down"), key("enter"), key("home"), key("enter"));
    const lines = render(ctx, press(ctx, edited.state, key("left")).state);

    expect(lines).toContain(" Changes");
    expect(lines).toContain(" lead: thinking off");
    expect(lines).toContain(` › 1. User  ${PATHS.user}`);
    expect(lines).toContain(EVERY_PROJECT);
    expect(lines.some((line) => line.includes(PATHS.project))).toBe(false);
    expect(lines.some((line) => line.includes("enter to save"))).toBe(true);
  });

  it("shows no untrusted line and no project line in a plain trusted form", () => {
    const ctx = context();
    const lines = render(ctx, press(ctx, initialSetup(ctx), key("left")).state);

    expect(lines).not.toContain(EVERY_PROJECT);
    expect(lines.some((line) => line.startsWith(" Project:"))).toBe(false);
    expect(lines.some((line) => line.startsWith(" Proposed:"))).toBe(false);
  });

  it("shows the reasons on a proposed agent's tab and the project kind on the submit tab", () => {
    const ctx = proposedContext();

    expect(render(ctx, initialSetup(ctx))).toContain(" Proposed: search finds code");
    expect(render(ctx, press(ctx, initialSetup(ctx), key("tab")).state)).not.toContain(
      " Proposed: search finds code",
    );
    expect(render(ctx, press(ctx, initialSetup(ctx), key("left")).state)).toContain(
      " Project: A TypeScript library",
    );
  });

  it("shows only the window of model options around the cursor", () => {
    const ctx = {
      ...context(),
      models: Array.from({ length: 20 }, (_, index) => ({
        ref: `acme/m${index}`,
        contextWindow: 100_000,
        cost: { input: 1, output: 2 },
        thinking: ["off"],
      })),
    };
    const lines = render(ctx, press(ctx, initialSetup(ctx), key("enter")).state);

    expect(lines).toContain("   inherit (the main session's model)");
    expect(lines.some((line) => line.includes("more"))).toBe(true);
    expect(lines.some((line) => line.includes("acme/m19"))).toBe(false);
  });
});
