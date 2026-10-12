# Open review items

Everything else from the 2026-10-12 review is fixed, fixed differently by owner decision, or refuted; the result is in the code, `ARCHITECTURE.md` and the READMEs. Where the extensions read and write files, and what `worktree` is for: [file-locations.md](file-locations.md).

- **Residual pi queue window** (`core/adapter/pi-child.ts`, `deliver`). A message steered or queued as a follow-up after pi's last queue check but before `agent_settled` stays in pi's queue until the child's next prompt. Left: it is inside pi; the adapter's `running` flag closes every window it controls.
- **`disabledPlugins` cost** (`extensions/subagents/src/plugins/agent-view/index.ts`, `agent-list-view/index.ts`, `run-agent/index.ts`: `services.has(...)`). Switching off single plugins makes consumers handle optional services; with plugins always on those branches would go. Left: the README promises the setting; owner decision.
- **`worktree: true`** keep or delete: see the opinion at the end of [file-locations.md](file-locations.md). Owner decision.
- **npm publication** (`package.json` `files`, `version`). Install is documented from git and a local checkout only; whether the package is also published to npm is the owner's call.
