# working-indicator

A pi extension that replaces pi's plain `Working...` line with a spinner, a playful verb and the elapsed time of the current turn:

```
⠹ Percolating… (12s · esc to interrupt)
```

## What it does

- At session start and at every turn start the working indicator becomes the configured spinner, drawn in the theme's accent colour.
- While a turn runs, the working message shows a verb, the seconds since the turn started and the interrupt hint. The seconds advance every second; the verb changes every 8 seconds, picked at random from a fixed list.
- At turn end and on shutdown the message goes back to pi's default.
- Active only in `tui` mode; in other modes it does nothing.

## Configuration

Constants at the top of `src/working-indicator.ts`:

- `SPINNER`: one of `braille` (default), `dots`, `bar` or `mark`, from the `SPINNERS` table.
- `VERB_MS`: how long a verb stays, in milliseconds (8000).
- `TICK_MS`: how often the message is refreshed, in milliseconds (1000).

## Layout

`src/index.ts` is the pi entry and builds the extension on the shared pi adapter in `core/adapter/` (repository root); `src/working-indicator.ts` holds the spinners, the verbs and the turn timer, and depends only on `core/adapter/contract.ts`. Tests are under `test/`.
