# acme-pi: an example company package

An example of what a company builds on top of pi-extensions. Nothing here is loaded by the harness on its own: it is a pi package (skills) plus agent files, templates and one script. Replace "Acme", the tracker words and the departments with your own.

## What is in it

| Path | What it is |
|---|---|
| `package.json` | pi package manifest; exposes `skills/` |
| `departments.json` | departments, their repos, branch scheme and check command |
| `departments/<dept>/AGENTS.md` | department context, copied into every workbench |
| `agents/tech-lead.md` | the one company agent: reads the tracker and docs over MCP |
| `skills/feature`, `skills/epic` | the two workflows, user-invoked |
| `skills/workbench` | create, open and list workbenches, user-invoked |
| `skills/tracker` | how Acme uses its work-management MCP: statuses, links, labels |
| `skills/requirements-interview`, `write-spec`, `write-contract`, `task-briefs`, `review-axes` | steps the workflows call |
| `templates/` | artefact templates |
| `scripts/workbench.sh` | clones repos into a workbench, creates branches |
| `scripts/install-agents.sh` | copies `agents/` into pi's agent dir (needed until the harness can load agents from a package) |

## Install

```bash
pi install git:git.acme.internal/dev/acme-pi     # skills
./scripts/install-agents.sh                      # agents, rerun after each update
```

Add the tracker MCP server to `~/.pi/agent/mcp.json` (or import it with `/mcp-import claude apply`), then `/reload` and check it with `/mcp`.

## Use

```text
/skill:workbench new SHOP-812          # creates ~/work/SHOP-812, clones the repos you pick
cd ~/work/SHOP-812 && pi
/skill:epic SHOP-812                   # or /skill:feature SHOP-845
```

After a break, start pi in the workbench again and run the same skill: it reads `WORKBENCH.md` and the tracker and continues from the first open stage.
