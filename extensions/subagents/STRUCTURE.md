# Subagents structure

Folder layout only. Runtime behaviour is described in [ARCHITECTURE.md](ARCHITECTURE.md).

`core/` is theme-free logic that imports only `platform/pi-adapter/index.ts` and `platform/shared/index.ts`; `ui/` paints over `platform/ui-kit/index.ts` and may import `core/`; `api/` wires both into plugins and never leaks into them. Basenames are unique inside `api/`, `core/` and `ui/`.

```
extensions/subagents/
├── index.ts                               # the pi entry: re-exports the default from api/extension.ts
├── README.md                              # user documentation
├── ARCHITECTURE.md                        # runtime behaviour
├── STRUCTURE.md                           # this file
├── agents/                                # shipped agent definitions
│   ├── leads/                             # planner.md, implementer.md, reviewer.md, general.md (leads: they may start subagents)
│   └── chores/                            # scout.md, editor.md, fetch.md, shell.md, image.md, verifier.md (chores: subagents none)
├── prompts/
│   ├── main-session.md                    # the main session's prompt section
│   ├── main-session-agent-status.md       # added when the agent-status plugin is on
│   ├── base-system-prompt.md              # shared agent rules and the result contract
│   ├── handoff.md                         # the handoff instruction template ({{path}})
│   ├── create-agent.md                    # the /agents create brief
│   └── autosetup-skills.md                # the /agents setup skills brief
├── api/
│   ├── extension.ts                       # createManagedExtension: namespace, root, settings, plugins, childExclude, onError
│   ├── plugins.ts                         # the ordered plugin list
│   └── plugins/
│       ├── agent-registry.ts              # in-memory records, manifest restore, the `registry` service
│       ├── agent-definitions.ts           # agent files and overrides, the `definitions` service, reload
│       ├── run-agent.ts                   # runner, run_agent/message_agent/handoff tools, outbox, main prompt, block invalidation
│       ├── usage-report.ts                # reports agent usage to the spending channel
│       ├── agent-status.ts                # the agent_status tool
│       ├── limits.ts                      # per-agent context limit steps, handoff request and abort
│       ├── agent-panel.ts                 # panel below the editor, selection keys, the `pi-subagents` status
│       ├── interrupt.ts                   # Esc after an interrupted turn: confirm to stop running agents
│       ├── agent-setup.ts                 # /agents setup, autosetup and the agent_skills_proposal tool, /agents create, the `agentSetup` service
│       ├── agent-view.ts                  # /agents: menu, list and agent view, the `agentView` service
│       └── fetch-tool.ts                  # the fetch tool as the `fetchTool` service
├── core/
│   ├── model/
│   │   ├── plugin.ts                      # Plugin: the shared contract's Plugin over the subagents services, settings and events
│   │   ├── events.ts                      # BusEvents and Bus (the shared contract's Bus): agent:changed, agent:closed, agent:turn, agent:usage, batch:settled
│   │   ├── agent-record.ts                # AgentRecord, AgentDefinition, registry, definitions, runner and handoff service types, chain helpers, grantText, grantOrNone, sameGrant, isLead
│   │   ├── settings.ts                    # Settings schema, defaults, settings files, disabledPlugins, reloadSettings
│   │   ├── agent-schema.ts                # frontmatter and override field types, AGENT_SCOPE_ALL, INHERIT_MODEL, PLAIN_NAME
│   │   ├── agent-override.ts              # override value checks for model, thinking and skills
│   │   ├── model-resolution.ts            # resolutionProblem: the one text for a model that does not resolve
│   │   ├── context-limit.ts               # effectiveContextLimit
│   │   ├── manifest.ts                    # pastRecords: manifest.json read and restore
│   │   └── paths.ts                       # NAMESPACE, MANIFEST_FILE, agents dir, handoff path, builtin, user and project agent dirs
│   ├── components/
│   │   ├── receipt.ts                     # formatCalls, receipt segments, plainReceipt, agentReceipt, firstLine, cutChars
│   │   ├── refresh.ts                     # tickFor (tick cadence) and watchAgents (throttled refresh and ticker)
│   │   └── tree.ts                        # isTerminal, stoppableAgents, withLinks, carrySelection, treeOrder
│   ├── agent-definitions/
│   │   ├── loader.ts                      # parseDefinition (with the path relative to its agents dir), loadDefinitions: files, then the agents.<name> overrides and their checks
│   │   ├── fields.ts                      # frontmatter field rules
│   │   ├── yaml-lite.ts                   # the frontmatter parser
│   │   └── prompt.ts                      # assemblePromptAppend: base prompt plus the agent body
│   ├── agent-registry/
│   │   └── registry.ts                    # createRegistry: records, manifests, events
│   ├── run-agent/
│   │   ├── runner.ts                      # createRunner: batches, launch, spawn, events, close, stop, wake
│   │   ├── tools.ts                       # run_agent and message_agent specs, params and details types, createPendingCalls, describeRunAgent
│   │   ├── handoff-tool.ts                # every child's handoff tool, HandoffRows
│   │   ├── handoff.ts                     # createHandoff: the handoff template and schema service
│   │   ├── outbox.ts                      # createOutbox: wake texts for the main session and agent callers
│   │   ├── placement.ts                   # createPlacer: an agent's dir and cwd, worktree placement
│   │   ├── worktree.ts                    # createWorktree, removeWorktree
│   │   ├── result.ts                      # storeResult, pickResult, chainTotals, batchMessage
│   │   ├── task.ts                        # composeTask: the child's first message
│   │   ├── model-text.ts                  # resolutionError: run_agent's model error text
│   │   └── semaphore.ts                   # createSemaphore: the maxConcurrent slots
│   ├── agent-status/
│   │   └── snapshot.ts                    # AgentSnapshot, snapshotOf, snapshotLine, agent_status params and details, unknownText
│   ├── limits/
│   │   └── context-step.ts                # contextStep, softWarning
│   ├── agent-panel/
│   │   └── panel-state.ts                 # createPanelState, panelRows, selectedIndex, reconcile, panelWindow (start, end and below)
│   ├── agent-setup/
│   │   ├── scope.ts                       # Scope, SCOPES, SetupChange
│   │   ├── line.ts                        # parseSetupLine: the one-line /agents setup form (refuses skills= on a chore), SETUP_USAGE
│   │   ├── write.ts                       # mergeChanges, writeChanges, overriddenFields
│   │   ├── create.ts                      # createAgentCommand: /agents create checks and the brief, CREATE_USAGE
│   │   ├── autosetup.ts                   # AUTOSETUP_TYPE, INTERACTIVE_TERMS, hasSkillsOverride, candidateSkills, projectListing, autosetupBrief
│   │   ├── proposal.ts                    # agent_skills_proposal definition, checkProposal, proposalUnchanged, result texts
│   │   ├── agent-template.ts              # agentTemplate: the lead and chore skeletons the brief embeds
│   │   └── template.ts                    # fillTemplate: the {{key}} fill of the briefs
│   ├── agent-view/
│   │   ├── source.ts                      # createAgentSource: reads an agent's session file, re-parsing on change
│   │   └── list-model.ts                  # list sections, listCounts, countsText, subtitle, clearTargets, MAX_CLOSED_ROOTS
│   └── fetch-tool/
│       ├── fetch.ts                       # fetchPage: request, limits, redirects
│       └── text.ts                        # readableText, pageText, supported content types
├── ui/
│   ├── components/
│   │   ├── format.ts                      # receiptText, truncatePainted, padEndCols, innerWidth, padLine, alignRight, wrapCols
│   │   ├── state-text.ts                  # state marks, glyphs, spinner, state words, stopWords
│   │   ├── agent-row.ts                   # the shared agent row: rowLayout, renderRow, renderRows, modelLabel
│   │   └── tree-glyphs.ts                 # nestPrefix: the tree connector glyphs
│   ├── run-agent/
│   │   ├── render.ts                      # renderBlock: the run_agent block, BlockHints
│   │   ├── pending-rows.ts                # pendingRows: run_agent and message_agent renderResult over renderBlock
│   │   └── handoff-row.ts                 # handoffRows: the handoff tool's call and result rows
│   ├── agent-status/
│   │   └── status-text.ts                 # statusCall, statusResult: the agent_status rows
│   ├── agent-panel/
│   │   ├── panel-lines.ts                 # panelLines: the agent rows, the two always-reserved more-slots (ui-kit moreRow) once the window starts below the top or ends above the bottom, the always-present hint row and the closing blank line
│   │   ├── keys.ts                        # panelKeyHandler, selectFirst: the captured editor keys
│   │   └── panel.ts                       # createPanelWidget: the belowEditor widget handle
│   ├── agent-setup/
│   │   ├── form.ts                        # setup form state, roles, proposed drafts, fieldsOf, fieldValue, the Previous/Suggested PRESETS (presetsOf, presetFieldsOf), selectedRow, changeRows for the Submit tab, FIELD_ROWS and INFO_ROWS, pickers with the all row and the filter, BLOCK_ROWS, DETAIL_LINES and the per-picker listHeight, scopes and keys
│   │   ├── setup-render.ts                # renderSetup: the form (agent block, preset rows and info view, or an open picker fitted into their rows; Submit change window padded to the agent-tab height), the Leads/Chores tab bar, the locked chore skills row and the picker title row with its query
│   │   └── setup-overlay.ts               # setupForm: the HostUi.showForm factory
│   └── agent-view/
│       ├── picker.ts                      # the /agents subcommands and the menu picker
│       ├── overlay.ts                     # createAgentsOverlay: the list/view host
│       ├── list.ts                        # createAgentList: the agents list (feedback row always reserved)
│       ├── list-hints.ts                  # listHint: the list's key hints (exits first)
│       ├── view.ts                        # createAgentView, headerLines: one agent's transcript (notice row always reserved)
│       └── request-block.ts               # requestLines: the collapsed Request block
└── tests/
    ├── plugins.test.ts                    # the plugin list and its order
    ├── model/
    │   ├── agent-record.test.ts           # isLead, including the shipped general agent
    │   ├── context-limit.test.ts          # effectiveContextLimit
    │   ├── paths.test.ts                  # paths helpers
    │   └── settings.test.ts               # settings schema, overrides and files
    ├── components/
    │   ├── agent-row.test.ts              # agent row layout
    │   ├── format.test.ts                 # receipt and painted formatting
    │   ├── refresh.test.ts                # tick cadence and watchAgents
    │   ├── state-text.test.ts             # marks and words
    │   └── tree.test.ts                   # chains, terminals and tree order
    ├── plugins/
    │   ├── agent-definitions/             # agent-definitions.test.ts (plugin), fields.test.ts
    │   ├── agent-panel/                   # agent-panel.test.ts (plugin), model.test.ts (panel state)
    │   ├── agent-registry/                # agent-registry.test.ts (plugin), registry.test.ts
    │   ├── agent-setup/                   # agent-setup.test.ts (plugin), agent-template, autosetup, create, form, line, proposal, render, write tests
    │   ├── agent-status/                  # agent-status.test.ts (plugin)
    │   ├── agent-view/                    # list, list-model, menu, overlay, request-block, view tests, fixtures/ and __snapshots__/
    │   ├── fetch-tool/                    # plugin.test.ts, fetch.test.ts, text.test.ts
    │   ├── interrupt/                     # interrupt.test.ts
    │   ├── limits/                        # limits.test.ts
    │   ├── run-agent/                     # run-agent, describe-run-agent, render, handoff, handoff-tool, nesting, skills, models,
    │   │                                  #   mcp, message-agent, spawn-cap, stop-grace, successor-chain, worktree, fetch-grant tests
    │   └── usage-report/                  # usage-report.test.ts
    ├── live/                              # local-only, PI_LIVE_MODEL: run-agent, nesting, grants, handoff, worktree
    └── support/                           # the one support folder test/evals/subagents/ may import
        ├── subagents-harness.ts           # startPlugins, createHarness, spawnAgents, tempDir, pluginSettings over test/framework
        ├── live-harness.ts                # createLiveHarness over the default export: seed, agents, wakes, chains
        ├── routing-session.ts             # mainSessionPrompt, recordingTools: the routing eval's main prompt and run_agent stubs
        ├── agent-records.ts               # agentRecord, newAgentInput fixtures; AgentRecord and chain helpers for evals
        ├── agent-patch.ts                 # patchAgentFile, shippedGroup, modelForGroup: agent files for live tests
        ├── agent-patch.test.ts            # the agent file patcher
        ├── overlay-rows.ts                # selectedRow: the selected overlay row
        ├── recorded-grep-session.ts       # grepSession: a recorded grep agent session
        └── setup-context.ts               # context, proposedContext, PATHS, press, render: the /agents setup form fixture
```
