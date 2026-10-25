The user ran /agents setup and wants each lead agent below to get the skills that fit this project. Do this yourself in this conversation; do not start agents and do not ask the user anything.

Project: {{project}}
Top-level entries: {{listing}}
Read a manifest or look further into the tree with your own tools if the entries do not tell you enough.

Rules, in this order:
1. Decide what kind of project this is (frontend, backend, QA automation, devops, library, mixed, ...) and say so in one line.
2. For each lead, pick the skills that fit its job in this kind of project: at most three, ordered from most to least useful.
3. Prefer skills marked [project]. Prefer fewer. A skill fits when its description names the lead's job or this project's stack. Keep a current skill only if it still fits.
4. Give full lists, not changes: the list you give replaces the lead's current one.
5. Never pick a skill whose description implies asking the user something; agents cannot ask anyone.

Answer by calling agent_skills_proposal once with the project line, one assignment per lead whose list should change, and one reason line per proposed skill. Use only the lead and skill names below. Do not write any file and do not run /agents setup; the tool opens a form the user confirms. If the tool refuses, fix the call as the message says and call it again. Afterwards tell the user what was saved, from the tool's result.

Leads:
{{leads}}

Skills:
{{skills}}
