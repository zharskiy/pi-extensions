import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTempDirs } from "../../../test/framework/index.ts";
import { startPiSession } from "../../../test/framework/pi/index.ts";
import modelDefault from "../index.ts";

const temp = useTempDirs();

const savedThinking = (agentDir: string) =>
  JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")).defaultThinkingLevel;

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

type SessionOptions = {
  factory?: Parameters<typeof startPiSession>[0]["factory"];
  startLevel?: string;
};

const startSession = async ({ factory = modelDefault, startLevel = "high" }: SessionOptions = {}) => {
  const agentDir = temp.make("pi-model-default-agent-");
  const cwd = temp.make("pi-model-default-cwd-");
  const models = [
    { id: "alpha", reasoning: true },
    { id: "beta", reasoning: true },
    { id: "plain", reasoning: false },
  ];
  const settings = { defaultProvider: "fake", defaultModel: "alpha", defaultThinkingLevel: startLevel };
  const started = await startPiSession({ agentDir, cwd, factory, settings, models });

  return { ...started, agentDir };
};

describe("the thinking level across model switches in a real pi session", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps the picked level as the default and puts the session back on it after a switch", async () => {
    const { session, agentDir, model } = await startSession();

    session.setThinkingLevel("low");

    await vi.waitFor(() => expect(savedThinking(agentDir)).toBe("low"));

    await session.setModel(model("beta"));
    await settle();

    expect(session.thinkingLevel).toBe("low");
    expect(savedThinking(agentDir)).toBe("low");

    session.dispose();
  });

  it("does not save the clamped level of a model without thinking", async () => {
    const { session, agentDir, model } = await startSession();

    session.setThinkingLevel("low");

    await vi.waitFor(() => expect(savedThinking(agentDir)).toBe("low"));

    await session.setModel(model("plain"));
    await settle();

    expect(session.thinkingLevel).toBe("off");
    expect(savedThinking(agentDir)).toBe("low");

    await session.setModel(model("beta"));
    await settle();

    expect(session.thinkingLevel).toBe("low");
    expect(savedThinking(agentDir)).toBe("low");

    session.dispose();
  });

  it("saves a level picked after a switch", async () => {
    const { session, agentDir, model } = await startSession();

    session.setThinkingLevel("low");
    await session.setModel(model("beta"));
    await settle();

    session.cycleThinkingLevel();

    await vi.waitFor(() => expect(savedThinking(agentDir)).toBe("medium"));
    expect(session.thinkingLevel).toBe("medium");

    session.dispose();
  });

  it("lets a switch land where pi puts it while no level was picked, and saves nothing", async () => {
    const { session, agentDir, model } = await startSession();

    await session.setModel(model("plain"));
    await settle();

    expect(session.thinkingLevel).toBe("off");
    expect(savedThinking(agentDir)).toBe("high");

    session.dispose();
  });

  it("does not save the clamp of the chosen level put back after a switch", async () => {
    const { session, agentDir, model } = await startSession({ startLevel: "medium" });

    Object.assign(model("alpha"), { thinkingLevelMap: { xhigh: "xhigh" } });
    session.setThinkingLevel("xhigh");

    await vi.waitFor(() => expect(savedThinking(agentDir)).toBe("xhigh"));

    await session.setModel(model("beta"));
    await settle();

    expect(session.thinkingLevel).toBe("high");
    expect(savedThinking(agentDir)).toBe("xhigh");

    await session.setModel(model("alpha"));
    await settle();

    expect(session.thinkingLevel).toBe("xhigh");

    session.dispose();
  });

  it("does not save the level a switch lands on when its event reaches the extension after the switch", async () => {
    const { session, agentDir, model } = await startSession({
      factory: (pi) => {
        pi.on("thinking_level_select", () => new Promise((resolve) => setTimeout(resolve, 10)));

        return modelDefault(pi);
      },
    });

    session.setThinkingLevel("low");

    await vi.waitFor(() => expect(savedThinking(agentDir)).toBe("low"));

    await session.setModel(model("plain"));
    await settle();

    expect(session.thinkingLevel).toBe("off");
    expect(savedThinking(agentDir)).toBe("low");

    await session.setModel(model("beta"));
    await settle();

    expect(session.thinkingLevel).toBe("low");
    expect(savedThinking(agentDir)).toBe("low");

    session.dispose();
  });
});
