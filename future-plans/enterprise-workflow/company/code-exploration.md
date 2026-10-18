# Code exploration: agentic search, indexes and "RAG" for large polyrepos

Date: 2026-10-17. Scope: whether this extension set should support retrieval-augmented exploration, and the simplest design that works for a large polyrepo (several frontend stacks, a backend, a QA-automation codebase, with the same business logic repeated across repos and layers) while staying abstract, optional and inside the file-write rules in `AGENTS.md`.

Starting point in this repo: the main session delegates codebase questions to `scout` (`extensions/subagents/agents/chores/scout.md`: `tools: [read, grep, find, ls]`, `skills: []`, `mcp: false`, returns `path:line` findings). Skills reach an agent through its file, an `agents.<name>.skills` override (`/agents setup`) or the per-task `skills` parameter; MCP reaches an agent only with `mcp: true`, and the override schema accepts `model`, `thinking` and `skills` only (`ARCHITECTURE.md`, "Agent definitions and prompts"). There is no "epic" workflow in the code today; the closest is `planner` batches run by the main session.

## 1. The debate: agentic search vs semantic indexes

**Agentic search (grep/glob/read driven by the model).** Claude Code's lead said early versions used a local vector DB and the team moved to agentic search because it "outperformed everything else by a lot", while admitting the evaluation was largely "vibes", and citing staleness, security and permission complexity of an index ([Pragmatic Engineer interview](https://newsletter.pragmaticengineer.com/p/building-claude-code-with-boris-cherny?open=false)). Anthropic's own guidance describes the hybrid: memory files "dropped into context up front", glob and grep for "just-in-time" retrieval, sub-agents that "return only a condensed, distilled summary", and structured note-taking outside the context window ([Effective context engineering, 2025-09-29](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)). Codex ships ripgrep and glob tools plus merged `AGENTS.md` files, with no documented index ([third-party tool reference](https://codex.danielvaughan.com/2026/06/03/codex-cli-built-in-tool-surface-complete-reference-shell-file-search-image-multi-agent/)). Cursor itself notes that "most agent harnesses, including Cursor's, default to ripgrep" and that "agents just love to use grep" ([Fast regex search, 2026-03-23](https://cursor.com/blog/fast-regex-search)).

**Retreats from embeddings.** Sourcegraph dropped embeddings for Cody Enterprise in favour of its search engine, citing scale across many large repos and lower security and maintenance burden ([Cody FAQ](https://sourcegraph.com/docs/cody/faq)). Continue deprecated its embeddings-based `@Codebase` provider in favour of agent-mode tools ([Continue docs](https://docs.continue.dev/reference/deprecated-codebase)).

**Evidence for semantic indexes.** Cursor reports +12.5% answer accuracy on average (6.5–23.5% by model) when semantic search is added to grep, and in an online A/B test +2.6% code retention on codebases over 1,000 files (+0.3% overall); it says "the combination of these two leads to the best outcomes" ([Cursor, 2025-11-06](https://cursor.com/blog/semsearch)). Cursor's index costs are real: tens of thousands of files "can take hours" to index; reusing a teammate's index cut p99 time-to-first-query from 4.03 h to 21 s ([Secure codebase indexing, 2026-01-27](https://cursor.com/blog/secure-codebase-indexing)). Augment claims 70%+ better agent results with its Context Engine MCP across several agents on 900 Elasticsearch PR attempts (vendor benchmark, no isolated grep baseline) ([Augment](https://www.augmentcode.com/blog/context-engine-mcp-now-live)). Zilliz's `claude-context` MCP (BM25 + vectors, Merkle-tree incremental indexing) claims 40% fewer tokens, self-reported ([eval README](https://glama.ai/mcp/servers/@zilliztech/claude-context/blob/2484ae29b3a9c92815f1524cbb9924b3e241ec17/evaluation/README.md)).

**Independent evaluations (2026).** An empirical study on SWE-QA found vector-index semantic search answered 65.2% correctly vs 46.2% for grep-style search delegated to a subagent, at under half the cost per correct answer; 41.8% of the agentic failures happened at the planner–subagent handoff and were "silent", confident and wrong ([arXiv 2608.01507](https://arxiv.org/abs/2608.01507)). Agent Retrieval Bench (25 repos, 392k files) found "no single retrieval family dominates": embeddings won MRR and recall, an aider-style RepoMap won budgeted context yield at 8k tokens, and logged agent trajectories missed every gold file on 27–35% of samples ([arXiv 2607.24882](https://arxiv.org/abs/2607.24882)). A practitioner benchmark on ContextBench raised Claude Code's file precision from 65% to 87% with windowed reads plus semantic search, but recall was mixed and stock Claude Code had the best file recall ([AI Engineer talk](https://ai.engineer/talks/zKk7sDMGDEQ-benchmarking-semantic-code-retrieval-on-claude)).

**Faster agentic search instead of indexes.** Cognition trained small models for parallel search (up to 8 calls per turn, 4 turns) and returns "a list of files with line ranges" instead of summaries, weighting precision over recall because polluting the main context is worse than omitting something; first turns in their agents spent over 60% on retrieval ([SWE-grep, 2025-10-16](https://cognition.com/blog/swe-grep)). Cursor built a local sparse n-gram index to speed up regex because `rg` calls in big monorepos "routinely" took over 15 s ([Cursor](https://cursor.com/blog/fast-regex-search)).

**Hybrid and structural options.** Aider's repo map ranks files and symbols with a dependency graph and sends a ~1k-token map with each request ([aider docs](https://aider.chat/docs/repomap.html)). Serena exposes language-server symbol tools (`find_symbol`, `find_referencing_symbols`) over MCP ([catalogue entry](https://archestra.ai/mcp-catalog/oraios__serena)). Greptile builds a call/import graph of the repo ([docs](https://www.greptile.com/docs/how-greptile-works/graph-based-codebase-context)).

Reading: the evidence is genuinely mixed. Semantic retrieval helps precision and concept queries ("where is discount eligibility decided?") when names differ; grep wins recall on exact identifiers and needs no upkeep. Every serious vendor that kept an index runs it as a service with incremental sync and access control, not as a side feature of a client.

## 2. Enterprise polyrepo specifics

**Cross-repo engines.** Zoekt (trigram index, JSON and gRPC APIs, maintained by Sourcegraph) ([repo](https://github.com/sourcegraph/zoekt)) powers GitLab's Exact Code Search over 48 TB and millions of repositories ([GitLab, 2025-06-25](https://about.gitlab.com/blog/exact-code-search-find-code-faster-across-repositories)). Sourcegraph adds Deep Search, an agent over its search and code navigation that runs inside the instance and returns sourced answers ([docs](https://sourcegraph.com/docs/deep-search)). Livegrep targets ~GB-scale regex search ([repo](https://github.com/bkrausz/livegrep)).

**Credible MCP servers for code search** (all configurable in pi's `mcp.json`, none needing code in this repo):
- Sourcegraph official MCP (v6.8+, Enterprise; keyword, natural-language, commit/diff search, file reads, Deep Search) ([changelog](https://sourcegraph.com/changelog/sourcegraph-mcp-server)).
- GitHub MCP server `search_code` with `org:`, `repo:`, `language:`, `path:` qualifiers; local server works with GHES via `--gh-host` ([repo](https://github.com/github/github-mcp-server)).
- Sourcebot `@sourcebot/mcp` over a self-hosted Zoekt-based instance (search, file reads, repo listing) ([docs](https://docs.sourcebot.dev/docs/more/mcp-server)); community `zoekt-mcp` for a bare Zoekt ([listing](https://glama.ai/mcp/servers/@divar-ir/zoekt-mcp)).
- Augment Context Engine MCP and Zilliz `claude-context` for semantic retrieval (above).
- Serena for symbol navigation within a checkout; DeepWiki MCP for generated docs of public repos ([listing](https://mcpservers.org/id/servers/devin/deepwiki)).

Amp's "Librarian" is the clearest product pattern: a dedicated subagent for multi-repo and remote code search, separate from local grep ([Amp, 2025-10-20](https://ampcode.com/news/librarian)).

**Is ripgrep over a local master root enough?** Raw speed is not the limit: ripgrep searches a cached 13 GB file in about 1 s ([ripgrep README](https://cdn.jsdelivr.net/gh/BurntSushi/ripgrep@master/README.md)). The limits are (a) unscoped searches over tens of GB that hit disk and take 10+ s per call, which Cursor observed in practice; (b) result volume: a common business term matched in five repos floods a scout's context; (c) vocabulary mismatch across stacks, which grep cannot bridge; (d) checkouts that are stale or absent on the developer's machine. No source gives a repo-count threshold. A defensible rule of thumb from the sources: local grep is fine while the repos the task needs are checked out and individual `rg` calls stay at a few seconds; beyond that, or when the relevant repos are not local, a server-side index (Zoekt/Sourcegraph/GitHub) via MCP is the established answer.

## 3. Knowledge beyond code

Every major tool ships a "read this first" layer: `AGENTS.md`/`CLAUDE.md` hierarchies loaded up front (Anthropic guidance above; Codex merges them top-down), Cursor rules, and Agent Skills whose name and description are always visible while the body loads on demand ([Anthropic, Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)). The "generate once, refresh" pattern exists as aider's computed repo map, Greptile's graph, DeepWiki's generated wikis, and Anthropic's structured note-taking. For the polyrepo case the high-value knowledge is small and stable: which repo holds which layer, the glossary mapping a business concept to its names in each stack (e.g. the frontend's term, the backend entity, the QA page object), and pointers to ADRs. This is exactly what grep cannot infer and what an embedding index only approximates.

## 4. Design options

| Approach | Setup cost | Quality on large polyrepo | Maintenance | Fits abstract rule and write rules |
|---|---|---|---|---|
| A. Nothing new: scout + skills + company MCP | None in repo; company configures MCP | Good with an MCP index; weak cross-repo with grep only | None for us | Yes |
| B. Knowledge convention (map skill, refreshed by an agent) | Small: docs and prompt lines | Big gain on vocabulary mismatch and "which repo" | Owner refreshes the map; stale map is visible | Yes, if the map is a normal skill written by an agent on the user's request |
| C. Built-in local index (embeddings or symbols) | Large: chunking, embeddings, storage, sync | Mixed evidence; best case +12% accuracy | High: staleness, re-indexing, per-language parsers | No: needs an embedding provider and model choice; index files must sit under the agent dir |
| D. Pluggable "search provider" abstraction | Medium: new interface and settings | Same as A | Medium: duplicates MCP | Yes, but MCP already is this abstraction |

**C** costs most and conflicts with the rules: an embedding model is a provider choice the code would have to name or configure, and the index is a new class of persistent state. The vendors who do it well (Cursor, Augment, Sourcegraph) run it as a service with sync and access control; a user who wants that can attach their MCP server today. **D** reinvents MCP: a "provider" is a tool behind a protocol, which pi's MCP built-in already handles, including per-agent opt-in via `mcp:`.

**Is embeddings "RAG" worth building into an open-source extension in 2026? No.** The gains are real but modest and contested, the maintenance is a product of its own, and the same capability is available as optional MCP servers that the extension can use without knowing about them.

## Recommendation

A + B, with three small changes and no new runtime component.

1. **Code map as a skill.** Document (README, "Exploring several repositories") a convention: a project or user skill, e.g. `code-map`, whose `SKILL.md` lists the repo roots (absolute or relative to a master root), the layer each holds, a glossary of business terms with their names per stack, and pointers to ADRs and docs. It is drafted and refreshed by an ordinary agent run on the user's request (a `general` or `implementer` task with a shipped brief), so the extension itself writes nothing new.
2. **Scout reads the map and searches wide.** Add to `scout.md`: if a skill describes a code map, read it first; translate the question into each stack's names; search every listed root, narrowest paths first; group findings by repo and layer, and list "related logic elsewhere" separately. Keep `path:line` output (Cognition's evidence favours located findings over summaries). Users give scout the skill once with `/agents setup scout skills=code-map`.
3. **Cross-repo search via MCP, opt-in.** Document a recipe: configure a company code-search MCP server (Sourcegraph, Sourcebot/Zoekt, GitHub) and create an own read-only explorer with `/agents create` and `mcp: true`; or allow `mcp` in `agents.<name>` overrides so scout can be switched on without a new agent (open question).

**Epic (cross-repo):** the planner reads the map, then batch 1 starts one scout per affected repo or layer in parallel (frontend A, frontend B, backend, QA), each brief naming the concept in that stack's terms; with an MCP explorer configured, one extra explorer runs an org-wide query to catch repos the map missed. Results feed the plan's Known lines.

**Single-repo bug fix:** one scout greps the current repo as today; the map is only consulted for vocabulary, and a "related logic elsewhere" line flags duplicates the fix may also need.

## Open questions

- Should `agents.<name>` overrides accept `mcp`, so a user can give scout company search without copying its file? This touches the override schema and `/agents setup`.
- Should the main-session prompt allow passing a map skill to chores per task (today: "chores take none"), or is the `/agents setup` override enough?
- Does pi's `grep`/`find` work well on absolute paths outside cwd, and do read permissions or trust rules restrict a master root of sibling repos? Needs a quick test.
- Should a shipped `map` refresh brief be a prompt file, a command, or only README text?
- How to signal a stale map: a "last refreshed" line plus a check in the scout's Open section when listed paths no longer exist?
- Worth a live test: the same cross-repo question with and without the map skill, measuring files found and tokens used.
