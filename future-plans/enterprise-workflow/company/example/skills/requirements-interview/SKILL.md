---
name: requirements-interview
description: Interview the user until requirements are shared and nothing is silently assumed. Use when a workflow reaches its requirements stage, or when the user asks to be grilled on a feature or epic.
---

# Requirements interview

Adapted from Matt Pocock's `grilling` skill.

- Map the decisions as a tree: each decision opens the decisions that hang off it. The frontier is every decision whose prerequisites are settled.
- Ask the whole frontier in one round. Number each question, give your recommended answer, and word it so "yes" accepts the recommendation. Then wait. Plain chat text; use the `questionnaire` tool only for a round of independent choices with concrete options.
- Facts are your job, never the user's. A question the code, the tracker or a document can answer goes to a `scout` (local code) or `tech-lead` (tracker, wiki) first; ask the user only for decisions.
- Cover, by the end: who uses it and why, the observable behaviour (as `WHEN <event> THE SYSTEM SHALL <response>` lines), edge cases and errors, what is out of scope, the testing seam (the highest level a test can observe it from; ideally one), and, for an epic, which department owns each piece.
- Write nothing to files during the interview. Keep a running list in the conversation of decisions taken.
- Done when the frontier is empty and the user confirms the understanding is shared. Do not start the write-up before that confirmation.
