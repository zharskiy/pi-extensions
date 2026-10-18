---
name: write-spec
description: Turn a finished requirements interview into a spec file without interviewing again. Use right after the user confirms shared understanding in a feature or epic workflow.
---

# Write the spec

Adapted from Matt Pocock's `to-spec` skill.

- Synthesise from the conversation and the intake digest. Do not ask new questions; a gap you find goes under Open questions, and you tell the user.
- Use the template the workflow names: `templates/requirements.md` in this package (two folders up from this file) for both an epic's requirements and a feature's spec.
- User stories: a long numbered list, one behaviour each. Acceptance criteria as `WHEN … THE SYSTEM SHALL …`, each one checkable on its own.
- No file paths or code. Name modules and interfaces by their domain names; briefs and code change, the spec stays valid.
- Out of scope is required, even when short.
- Done when every decision from the interview appears in the file once, and the file has no template placeholder left.
