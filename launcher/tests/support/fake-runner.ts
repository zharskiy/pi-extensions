import { type CommandRunner, LauncherError, type RunOptions, type RunResult } from "../../shared/index.ts";

interface FakeCall {
  file: string;
  args: string[];
  options: RunOptions;
  interactive: boolean;
}

export type FakeResponder = (call: FakeCall) => Partial<RunResult> | undefined;

const answer = (respond: FakeResponder, call: FakeCall): RunResult => {
  const response = respond(call);

  if (response === undefined) {
    throw new LauncherError(`${call.file}: command not found`);
  }

  return { code: 0, stdout: "", stderr: "", ...response };
};

export const createFakeRunner = (respond: FakeResponder) => {
  const calls: FakeCall[] = [];

  const record = (file: string, args: string[], options: RunOptions, interactive: boolean) => {
    const call = { file, args, options, interactive };

    calls.push(call);

    return answer(respond, call);
  };

  const runner: CommandRunner = {
    run: async (file, args, options = {}) => record(file, args, options, false),
    spawnInteractive: async (file, args, options = {}) => record(file, args, options, true).code,
  };

  return { runner, calls };
};
