# evals

Evals judge the quality of prompts and agent files: does the main session route a request to the right agent, does the planner name the files a past commit changed, does the reviewer find a planted defect, does the implementer's change pass the commit's own tests. Each subject has a folder with its cases in `*-cases.ts` and its runner in `*.eval.ts`; helpers shared by one extension's evals live in `<extension>/support/`, with their unit tests in `<extension>/tests/` (those run under `npm run check`).

## Run

```bash
PI_LIVE_MODEL=provider/id[:thinking] npm run evals
PI_LIVE_MODEL=provider/id[:thinking] PI_EVAL_RUNS=5 npm run evals -- -t "reviews 686fc95"
```

Evals run real agents, locally only, and cost money. `npm run check` and CI never run them.

## Environment

`PI_LIVE_MODEL=provider/id[:thinking]` is the model the leads and the main session run on, the same variable the live tests read; `PI_LIVE_CHORE_MODEL` optionally puts the chore agents on a second model. Without the model or its pi credentials every eval fails at once with a message saying what is missing. `PI_EVAL_RUNS` (default 1) is how many times each case runs; a case passes when more than half of its runs pass (routing cases when every run does), and the planner, reviewer and implementer runs of a case run in parallel. `PI_EVAL_REPORT=<file>` additionally appends one JSON line per case to that file.

## Results

Each `npm run evals` writes to `test/evals/.results/<timestamp>/` (gitignored): `observations.jsonl` holds one JSON line per case (name, model, runs, pass rates per check, mean cost and duration, failed checks, the record of every run), and `sessions/` keeps the session files of the runs that failed. The routing eval runs a single main session rather than an agent chain, so its records carry the full event list (messages, tool calls, tool results) in `observations.jsonl` and it keeps no session snapshot. The console prints each run's line as soon as that run finishes, so a run that throws does not hide the others, and a summary per case. Set `PI_EVAL_RESULTS=<dir>` to write somewhere else; the hidden `npx vitest` run inside the implementer eval does not need it, so the eval strips it from that child's environment.

## Evals and live tests

A live test (`*.live.test.ts`, `npm run test:live`) checks mechanics with a real agent: wiring, grants, nesting, worktrees, handoff, wake. It is meant to pass every time and sits next to the code it tests. An eval (`*.eval.ts`, `npm run evals`) scores how well a prompt or an agent file does its job: it repeats each case, grades the runs against a rubric, passes on a threshold and reports cost and time. Changing a prompt or an agent file is the reason to run the evals.
