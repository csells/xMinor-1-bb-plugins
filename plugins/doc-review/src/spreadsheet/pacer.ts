// Cooperative scheduling for parsing that runs inside the bb server process.
//
// Spreadsheet parsing is CPU work on the same event loop that serves every
// other bb request. Long loops therefore hand control back every few
// milliseconds and stop as soon as the caller gives up.
import { setImmediate as nextTurn } from "node:timers/promises";

/**
 * Longest synchronous stretch between yields. Individual steps (one inflated
 * chunk) stay well under this, so real stalls land near the budget.
 */
const SLICE_MS = 8;

export class Pacer {
  readonly signal: AbortSignal | undefined;
  #sliceStart = performance.now();

  constructor(signal?: AbortSignal) {
    this.signal = signal;
    signal?.throwIfAborted();
  }

  /** Throws the abort reason once the caller has given up. */
  check(): void {
    this.signal?.throwIfAborted();
  }

  /** Yields to the event loop when the current slice has used its budget. */
  async pace(): Promise<void> {
    if (performance.now() - this.#sliceStart < SLICE_MS) return;
    await nextTurn();
    this.check();
    this.#sliceStart = performance.now();
  }
}
