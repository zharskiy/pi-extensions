---
name: review-axes
description: Review a change on two separate axes, spec and standards. Use when reviewing a PR or diff against its brief or spec.
---

# Two-axis review

Adapted from Matt Pocock's `code-review`.

Review the pinned diff range twice and report the axes separately; never merge or re-rank them.

- Spec axis: compare against the brief (and the spec it cites). Report missing or partial criteria, scope creep beyond Out of scope, and behaviour implemented but wrong. Quote the brief line for each finding.
- Standards axis: the repo's and the department's AGENTS.md rules first, then correctness, missing tests, and risky design as judgement calls. The repo's rules override generic advice.
- At most about 400 words per axis. A change that passes one axis and fails the other is reported as exactly that.
