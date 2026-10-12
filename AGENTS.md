# AGENTS.md

- [ARCHITECTURE.md](ARCHITECTURE.md): how it works.
- [STRUCTURE.md](STRUCTURE.md): where things are.

Checks:

- `npm run check`: typecheck, biome and unit tests. Run before finishing.
- `npm run test`: unit tests only.
- `npm run test:live`: real agents, local only, needs pi credentials and `PI_LIVE_MODEL`. Never run in CI.

Rules:

- Only `core/adapter` imports pi packages; extensions never import each other.
- No provider knowledge: no provider or model names in code, prompts, agent files or READMEs. Pi handles providers; cost comes from pi's own usage figures.
