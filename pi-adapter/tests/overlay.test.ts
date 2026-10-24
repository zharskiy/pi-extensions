import { type Terminal, TuiMainScreen } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OVERLAY_POLL_MS, overlaysCleared } from "../ui/overlay.ts";

const silentTerminal = (): Terminal =>
  ({
    start: () => {},
    stop: () => {},
    drainInput: async () => {},
    write: () => {},
    columns: 80,
    rows: 24,
    kittyProtocolActive: false,
    moveBy: () => {},
    hideCursor: () => {},
    showCursor: () => {},
    clearLine: () => {},
    clearFromCursor: () => {},
    clearScreen: () => {},
    setTitle: () => {},
    setProgress: () => {},
    setProgramStatus: () => {},
  }) as unknown as Terminal;

const box = { render: () => ["overlay"], invalidate: () => {} };

afterEach(() => {
  vi.useRealTimers();
});

describe("overlaysCleared", () => {
  it("resolves true at once without a TUI or an overlay", async () => {
    expect(await overlaysCleared(undefined)).toBe(true);
    expect(await overlaysCleared(new TuiMainScreen(silentTerminal()))).toBe(true);
  });

  it("waits for pi-tui's overlay to close", async () => {
    vi.useFakeTimers();

    const tui = new TuiMainScreen(silentTerminal());
    let cleared: boolean | undefined;

    tui.showOverlay(box);
    void overlaysCleared(tui).then((value) => {
      cleared = value;
    });

    await vi.advanceTimersByTimeAsync(OVERLAY_POLL_MS * 3);

    expect(tui.hasOverlay()).toBe(true);
    expect(cleared).toBeUndefined();

    tui.hideOverlay();
    await vi.advanceTimersByTimeAsync(OVERLAY_POLL_MS);

    expect(cleared).toBe(true);
  });

  it("resolves false when the signal aborts, before or while it waits", async () => {
    const tui = new TuiMainScreen(silentTerminal());
    const early = new AbortController();
    const late = new AbortController();

    early.abort();
    tui.showOverlay(box);

    const waiting = overlaysCleared(tui, late.signal);

    late.abort();

    expect(await overlaysCleared(tui, early.signal)).toBe(false);
    expect(await waiting).toBe(false);
  });
});
