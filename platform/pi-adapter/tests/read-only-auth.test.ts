import { chmodSync, copyFileSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { useTempDirs } from "../../../test/framework/index.ts";

const temp = useTempDirs();

const readOnlyDirs: string[] = [];

afterEach(() => {
  readOnlyDirs.splice(0).forEach((dir) => {
    chmodSync(dir, 0o755);
  });
});

const sandboxAgentDir = () => {
  const root = temp.make("pi-read-only-auth-");
  const render = join(root, "render");
  const agent = join(root, "agent");

  mkdirSync(render);

  mkdirSync(agent);

  writeFileSync(join(render, "auth.json"), "{}\n");

  writeFileSync(join(render, "models.json"), `${JSON.stringify({ providers: {} })}\n`);

  symlinkSync(join(render, "models.json"), join(agent, "models.json"));

  copyFileSync(join(render, "auth.json"), join(agent, "auth.json"));

  chmodSync(join(agent, "auth.json"), 0o444);

  chmodSync(render, 0o555);

  readOnlyDirs.push(render);

  return agent;
};

describe("the sandbox agent dir layout", () => {
  it("lets pi lock its read-only auth.json copy while models.json links into a read-only render dir", async () => {
    const agent = sandboxAgentDir();
    const runtime = await ModelRuntime.create({
      authPath: join(agent, "auth.json"),
      modelsPath: join(agent, "models.json"),
    });

    expect(runtime.getError()).toBeUndefined();
  });
});
