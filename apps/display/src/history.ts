/**
 * The layout editor's undo stack.
 *
 * Kept out of `layout-editor.ts` for the same reason `widget-options.ts`,
 * `ink.ts` and `ladder.ts` are: `boot()` holds every editor variable in one
 * closure, so a rule that lives inside it is a rule no test can reach. There is
 * no DOM in this package's test suite. This is the whole decision — what is
 * kept, what is dropped, and when an entry is not worth keeping — as a module
 * that runs on a string and knows nothing about a canvas.
 *
 * A snapshot is the serialised canvas, so restoring is a parse and a redraw;
 * the editor decides what goes into one. Undo only: a redo needs a second stack
 * and a rule for what invalidates it, and neither is asked for here.
 */

/**
 * Thirty steps back.
 *
 * Deep enough to cover a session of arranging — the fault this exists for is
 * "an accidental drag after twenty minutes" — and shallow enough that thirty
 * canvases of a handful of widgets each is a few tens of kilobytes. The cap
 * drops the *oldest*, so the recent past is what survives.
 */
export const UNDO_LIMIT = 30;

export interface History {
  /** Remember the canvas as it is *before* a mutation. */
  push(snapshot: string): void;
  /** The newest remembered canvas, removed from the stack. */
  undo(): string | undefined;
  /**
   * Drop the newest entry when the canvas came back to it.
   *
   * A drag that grabs a box and puts it down where it was pushed a snapshot on
   * the way in, and undoing to it would do nothing visible — which reads as
   * "undo is broken" rather than as "there was nothing to undo". Called with
   * the canvas as it ended up, at the end of an interaction.
   */
  settle(current: string): void;
  canUndo(): boolean;
  depth(): number;
}

export function createHistory(limit: number = UNDO_LIMIT): History {
  const stack: string[] = [];
  return {
    push(snapshot: string): void {
      if (limit <= 0) return;
      stack.push(snapshot);
      // The oldest goes, never the newest: a cap that refused new entries would
      // silently stop recording after thirty edits.
      if (stack.length > limit) stack.splice(0, stack.length - limit);
    },
    undo(): string | undefined {
      return stack.pop();
    },
    settle(current: string): void {
      if (stack.length > 0 && stack[stack.length - 1] === current) stack.pop();
    },
    canUndo(): boolean {
      return stack.length > 0;
    },
    depth(): number {
      return stack.length;
    },
  };
}
