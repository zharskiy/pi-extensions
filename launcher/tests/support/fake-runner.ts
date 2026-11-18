import { type CommandRunner, LauncherError, type RunOptions, type RunResult } from "../../shared/index.ts";

export interface FakeCall {
  file: string;
  args: string[];
  options: RunOptions;
  interactive: boolean;
}

type FakeAnswer = Partial<RunResult> | undefined;

export type FakeResponder = (call: FakeCall) => FakeAnswer | Promise<FakeAnswer>;

export interface FakeScript {
  argv: string[];
  result?: Partial<RunResult>;
  respond?: FakeResponder;
}

const answer = async (respond: FakeResponder, call: FakeCall): Promise<RunResult> => {
  const response = await respond(call);

  if (response === undefined) {
    throw new LauncherError(`${call.file}: command not found`);
  }

  return { code: 0, stdout: "", stderr: "", ...response };
};

export const argvOf = (call: FakeCall) => [call.file, ...call.args];

const startsWith = (argv: string[], prefix: string[]) => prefix.every((part, index) => argv[index] === part);

export const createFakeRunner = (respond: FakeResponder) => {
  const calls: FakeCall[] = [];

  const record = (file: string, args: string[], options: RunOptions, interactive: boolean) => {
    const call = { file, args, options, interactive };

    calls.push(call);

    return answer(respond, call);
  };

  const runner: CommandRunner = {
    run: (file, args, options = {}) => record(file, args, options, false),
    spawnInteractive: async (file, args, options = {}) => (await record(file, args, options, true)).code,
  };

  return { runner, calls };
};

export const createScriptedRunner = (scripts: FakeScript[], fallback: FakeResponder = () => undefined) =>
  createFakeRunner((call) => {
    const script = scripts.find((entry) => startsWith(argvOf(call), entry.argv));

    if (script === undefined) {
      return fallback(call);
    }

    return script.respond === undefined ? (script.result ?? {}) : script.respond(call);
  });
