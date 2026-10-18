---
epic: <EPIC-KEY>
title: <epic title>
tracker: <tracker link>
created: <date>
repos:
  be/order-service: { default: main, check: "./gradlew check", branch: none }
  fe/web-orders:    { default: main, check: "npm run check", branch: none }
  qaa/e2e-tests:    { default: develop, check: "npm run lint && npm run e2e -- --list", branch: none }
---

# Stage log

One section per workflow run. Each line: stage, status (`open`, `done`, `skipped: <why>`), date, artefact path or ticket keys.

## epic <EPIC-KEY>

- intake: open
- requirements: open
- contract: open
- split: open
- departments: open
- close-out: open

## feature <FEATURE-KEY> (<dept>)

- intake: open
- requirements: open
- spec: open
- briefs: open
- handover: open
