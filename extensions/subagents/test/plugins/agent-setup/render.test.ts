import { describe, expect, it } from "vitest";
import { initialSetup } from "../../../src/plugins/agent-setup/form.ts";
import { context, key, PATHS, press, render } from "./setup-context.ts";

describe("agent setup rendering", () => {
  it("renders the agent tab with its fields, tools note and MCP line", () => {
    const lines = render(context(), initialSetup(context()));

    expect(lines[1]).toBe(" ← □ lead  □ chore  ✓ Submit →");
    expect(lines).toContain(" lead Leads things.");
    expect(lines).toContain(" › Model     acme/big");
    expect(lines).toContain("   Thinking  high");
    expect(lines).toContain("   Skills    all");
    expect(lines.some((line) => line.includes("create your own agent with /agents create."))).toBe(true);
    expect(lines.some((line) => line.startsWith(" MCP: on"))).toBe(true);
  });

  it("lists the changes and both files on the submit tab, marking the project file when untrusted", () => {
    const ctx = context(false);
    const edited = press(ctx, initialSetup(ctx), key("down"), key("enter"), key("home"), key("enter"));
    const lines = render(ctx, press(ctx, edited.state, key("left")).state);

    expect(lines).toContain(" Changes");
    expect(lines).toContain(" lead: thinking off");
    expect(lines).toContain(`   1. This project  ${PATHS.project} (project not trusted)`);
    expect(lines).toContain(` › 2. User  ${PATHS.user}`);
    expect(lines.some((line) => line.includes("Enter save"))).toBe(true);
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
