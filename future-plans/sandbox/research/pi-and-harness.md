# Pi 1.3.0 isolation surface and where our extensions would change

Sources: the installed package `node_modules/@earendil-works/pi-coding-agent` (version 1.3.0, upstream github.com/earendil-works/pi) and this repo. Pi moved from badlogic/pi-mono and the `@mariozechner/*` scope to `@earendil-works/*`.

## What pi ships

### Documentation

- `docs/containerization.md`: "You can isolate the complete Pi process or keep Pi on the host and route selected tools into an isolated environment." Its method table:

| Method | Where pi runs | What is isolated | Credentials |
|---|---|---|---|
| Plain Docker | Container | Pi, built-in tools, `!` commands, extensions | Passed into the container |
| Docker Sandboxes | Managed sandbox | Same | Stay on the host, substituted by the proxy |
| OpenShell | Local or remote sandbox | Same | Policy-controlled credentials and inference routing |
| Gondolin extension | Host | Built-in tools and `!` commands | Stored credentials stay on the host, commands inherit host env vars |

  "Tool-only isolation does not constrain the host Pi process or extension tools that do not use the isolated backend." The OpenShell section: `openshell sandbox create --name pi-sandbox --from pi -- pi`, with `sandbox upload` and `download` for files. The plain Docker section gives a Dockerfile (`node:24-bookworm-slim`, bash, git, ripgrep, `npm i -g @earendil-works/pi-coding-agent`) and warns against mounting `~/.pi/agent`.
- `docs/security.md`: pi has no built-in sandbox; model output is untrusted; "Project trust does not limit what tool calls can access or affect"; whole-process isolation is "usually the strongest practical option".
- `docs/extensions.md`: `tool_call` can mutate input or block execution, and a failing handler blocks the tool. `user_bash` handlers return `{operations}` or `{result}`; since issue #9068 a failing handler fails closed instead of running on the host. `before_agent_start` can replace the system prompt (used by `ssh.ts` to rewrite the cwd line). `session_start` and `session_shutdown` bracket a VM's life.
- `docs/sdk.md`: `createAgentSession({cwd, tools, customTools, resourceLoader, sessionManager, settingsManager, modelRuntime, ...})`. There is no executor option; sandboxing goes through extensions or custom tools.

### Tool API

- Every built-in factory takes an operations backend: `createBashTool(cwd, {operations})`, `createReadTool`, `createWriteTool`, `createEditTool`, `createFindTool`, `createGrepTool`, `createLsTool`, with `BashOperations`, `ReadOperations` and so on exported from the package root.
- `BashOperations.exec(command, cwd, {onData, signal, timeout, env}) => Promise<{exitCode}>`. Timeout in seconds, signal exits as 128 plus the signal number, `null` counts as failure.
- `BashToolOptions` also has `spawnHook: ({command, cwd, env}) => {command, cwd, env}`, the least invasive wrapper (`sandbox-exec`, `bwrap`, `docker exec`). PI_* session variables are injected before the hook runs.
- The default backend `createLocalShellOperations` checks `fs.access(cwd)` first, so a guest-only cwd needs custom operations. `createLocalBashOperations()` is exported for wrapping.
- An extension that registers a tool with a built-in name replaces it (`examples/extensions/tool-override.ts`: "Implementing access control or sandboxing, routing tool calls to remote systems").

### Reference extensions

- `examples/extensions/sandbox/index.ts`: `bash` override over `@anthropic-ai/sandbox-runtime` (sandbox-exec on macOS, bubblewrap on Linux, domain allowlist), plus `user_bash`. Config in `.pi/sandbox.json` and a global `sandbox.json`. Its header notes the alternative of mutating bash input in `tool_call`.
- `examples/extensions/gondolin/index.ts`: QEMU micro-VM mounting the cwd at `/workspace`, overriding read, write, edit, bash, grep, find and ls with path translation. Issue #6297 fixed its allow-all network default. Commands inherit host environment variables, so it is not a credential boundary.
- `examples/extensions/ssh.ts`: `--ssh user@host[:path]` routes read, write, edit and bash over SSH.
- `examples/extensions/subagent/index.ts`: the official subagent example spawns child `pi` processes (`--mode json -p --no-session`) and parses JSON events. Each child loads its own extensions, so a parent-side override does not apply to children.
- `examples/extensions/bash-spawn-hook.ts`, `permission-gate.ts`, `protected-paths.ts`.

### Upstream state

- PR #5356 added the containerization guide and the Gondolin example. PR #8788 added the Docker Sandboxes section; a Docker Sandboxes team member maintains the pi kit at https://github.com/docker/sbx-kits-contrib/tree/main/pi.
- Issue #4104 asked for one filesystem abstraction all extensions share; the maintainer answered "yes, part of the big refactor". PR #903 (chained bash handlers) was rejected: "just wrapping the Bash tool ... is the best we can do for now".
- `packages/env` (`@earendil-works/pi-env`) is an SSH-based `RemoteExecutionEnv` built for Pi Durable (issues #10624, #10846). Not wired to the coding agent's extension API.
- `@earendil-works/pi-codemode` sandboxes scripts in QuickJS/WASM. It does not sandbox bash.
- No official Docker image or devcontainer. Community: cjermain/pi-less-yolo (whole pi in Docker), inoio/agents-sandbox (microsandbox VM per project), pi-pod/pipod (self-hosted control plane running pi in pods), navikt/cplt (kernel-level wrapper), langgenius/mosoo (hosted), himorishige/pi-openshell-subagent (one OpenShell sandbox per subagent through the TypeScript SDK, see openshell.md).

## Where this repo stands

- **Agents are in-process.** `core/adapter/pi-child.ts` creates each agent with `SessionManager.create(spec.cwd, spec.sessionDir, {parentSession})` and `createAgentSession({cwd, modelRuntime, settingsManager, resourceLoader, sessionManager, customTools, ...})`, binds extensions in print mode and drives it with `prompt`, `steer` and `followUp`. One `ModelRuntime` is shared by every agent. The child scope (`core/adapter/pi-scope.ts`) stops the subagents extension from loading inside a child. The runner calls `runtime.spawn(SpawnSpec)` from `extensions/subagents/src/plugins/run-agent/runner.ts`; the contract is `AgentRuntime.spawn` in `core/adapter/contract.ts`.
- **No interception today.** The repo has no `tool_call`, `user_bash` or tool override. The only tool listeners drive phase display. Nothing mentions sandbox, container, seatbelt, bubblewrap or openshell.
- **Built-in tools are pi's.** The child tool list is the definition's allowlist or the parent's active tools. Custom tools (`handoff`, `fetch` when listed, `run_agent`, `message_agent`, `agent_status`) are in-process closures passed as `customTools`; `fetch` does a plain host `fetch` with no policy, `handoff` writes to `<tmpdir>/pi-subagents/<session>/<agent>-handoff.md`.
- **Worktrees** (`run-agent/worktree.ts`): host-side `git worktree add -b pi-agents/<id>-<stamp> <cwd>/.pi/worktrees/<id>-<stamp> <sha>`, cwd passed as `SpawnSpec.cwd`. The worktree shares the host `.git`. All shipped agents have `worktree: false`.
- **Files**: `<session file minus .jsonl>/agents/<id>/` holds `manifest.json`, the child `.jsonl` and `result.md`. Every child reads the same host agent dir (credentials, settings, extensions, skills). MCP is on for leads, off for chores, and MCP servers connect inside the host process.
- **Other extensions** spawn nothing. Extensions talk over an in-process bus.

## Insertion points, least to most invasive

1. Run the whole pi process in a container, Docker Sandbox or OpenShell. No repo change; agents, worktrees and extensions are inside.
2. Inject an inline extension into the child loader's `extensionFactories` (`pi-child.ts`) that registers `bash` with sandboxed operations (or a `spawnHook`), plus `user_bash` for the main session. Covers built-in bash only.
3. Override all seven built-ins with operations (Gondolin or SSH pattern) for a filesystem boundary with pi on the host. Needs path translation and the cwd line in the system prompt. Still leaves `fetch`, `handoff`, MCP and codemode on the host.
4. A second `AgentRuntime` whose `spawn` starts `pi --mode json -p` inside a sandbox and carries the `ChildSession` surface (start, subscribe, send, wake, abort, dispose, ownUsage, lastText, runTexts, sessionFile) over RPC. The true per-agent boundary and the biggest change.

## What makes per-agent sandboxing hard here

- Shared process, model runtime, credentials, registry, semaphore and bus.
- Custom tools run in the host with no operations backend.
- MCP, codemode and extensions load from the host agent dir into each child.
- Agent dirs, handoff files and worktrees are host paths the sandbox would need mounted; the child session file must be host-visible for resume and read.
- Child settings copy the parent's, including provider config; `isProjectTrusted` passes through.
- Abort and shutdown are in-process with a 2 s settle.
