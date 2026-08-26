import { describe, expect, it } from 'vitest';
import { createHistory, UNDO_LIMIT } from '../src/history.js';

/**
 * The undo stack, as arithmetic on strings.
 *
 * The editor holds every one of its variables inside one 2,800-line `boot()`,
 * so anything decided in there is decided where no test can reach it — which is
 * the reason RFC 009 Phase 5 says to extract the decision logic rather than
 * rewrite the function. This is that extraction: what is kept, what is dropped
 * when the cap is reached, and when an entry was not worth keeping at all.
 *
 * The last of those is the one that reads as a bug when it is missing: a drag
 * that grabs a box and puts it back down where it was would otherwise leave a
 * step whose undo changes nothing on screen, which a household reads as "undo
 * is broken" rather than as "there was nothing to undo".
 */
describe('the editor undo stack', () => {
  it('gives back the most recent canvas first', () => {
    const history = createHistory();
    history.push('one');
    history.push('two');
    expect(history.undo()).toBe('two');
    expect(history.undo()).toBe('one');
    expect(history.undo()).toBeUndefined();
  });

  it('says whether there is anything to go back to', () => {
    const history = createHistory();
    expect(history.canUndo()).toBe(false);
    history.push('one');
    expect(history.canUndo()).toBe(true);
    history.undo();
    expect(history.canUndo()).toBe(false);
  });

  it('drops the oldest at the cap, never the newest', () => {
    // A cap that refused new entries would silently stop recording after
    // thirty edits — the arranging session this exists for is the one where
    // that would matter most.
    const history = createHistory(3);
    for (const entry of ['a', 'b', 'c', 'd']) history.push(entry);
    expect(history.depth()).toBe(3);
    expect([history.undo(), history.undo(), history.undo(), history.undo()]).toEqual([
      'd',
      'c',
      'b',
      undefined,
    ]);
  });

  it('forgets a step the canvas came back to on its own', () => {
    const history = createHistory();
    history.push('start');
    // The drag ended where it began.
    history.settle('start');
    expect(history.canUndo()).toBe(false);
  });

  it('keeps a step the canvas moved away from', () => {
    const history = createHistory();
    history.push('start');
    history.settle('moved');
    expect(history.undo()).toBe('start');
  });

  it('settles nothing when there is nothing to settle', () => {
    const history = createHistory();
    history.settle('anything');
    expect(history.depth()).toBe(0);
  });

  it('records thirty by default, which is a session of arranging', () => {
    expect(UNDO_LIMIT).toBe(30);
    const history = createHistory();
    for (let index = 0; index < 40; index++) history.push(String(index));
    expect(history.depth()).toBe(30);
    expect(history.undo()).toBe('39');
  });
});
