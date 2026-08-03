import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIFE_SAFETY_DISCLAIMER } from '../src/api/disclaimer.js';
import { interruptPush, PUSH_PROTOCOL_VERSION } from '../src/api/push.js';
import type { Interrupt } from '@maverick-wall/core';

/**
 * The disclaimer, and the push contract.
 *
 * Both are things that are easy to write once and then quietly lose. The
 * disclaimer is required in three places and a copy per screen is how three of
 * them end up saying different things; `wakeScreen` has to be on the wire
 * before an app ships, because adding it afterwards means a tablet in somebody's
 * hallway that never wakes for a tornado warning until they update it.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

describe('the life-safety disclaimer', () => {
  it('says the four things it has to say', () => {
    // Not paraphrased anywhere. Each of these is a specific alternative a
    // household should be using instead, or a link in the chain this does not
    // control.
    expect(LIFE_SAFETY_DISCLAIMER).toContain('not a life-safety system');
    expect(LIFE_SAFETY_DISCLAIMER).toContain('NOAA Weather Radio');
    expect(LIFE_SAFETY_DISCLAIMER).toContain('Wireless Emergency');
    expect(LIFE_SAFETY_DISCLAIMER).toContain('sirens');
    expect(LIFE_SAFETY_DISCLAIMER).toContain('internet connection, device, and power');
  });

  it('appears in the README', () => {
    const readme = read('README.md');
    expect(readme).toContain('not a life-safety system');
    expect(readme).toContain('NOAA Weather Radio');
  });

  it('is drawn from the constant on the settings screen and in the wizard', () => {
    /*
     * Asserted as an import rather than as text, deliberately.
     *
     * Checking the rendered wording would pass just as happily against a
     * second copy that had drifted. What has to be true is that there is one
     * source of the sentence, and these are the two screens that use it.
     */
    expect(read('apps/server/src/http/admin-alerts.ts')).toContain('LIFE_SAFETY_DISCLAIMER');
    expect(read('apps/server/src/http/setup.ts')).toContain('LIFE_SAFETY_DISCLAIMER');
  });
});

describe('the push contract', () => {
  function interrupt(over: Partial<Interrupt> = {}): Interrupt {
    return {
      ruleId: 'r', key: 'k', source: 'nws', action: 'banner', title: 'Flood Advisory',
      severity: 'Moderate', urgency: 'Expected', dismissible: true, wakeScreen: false,
      piercesNightMode: false, priority: 0, ...over,
    };
  }

  it('carries wakeScreen where an app can find it', () => {
    const push = interruptPush(
      [interrupt({ action: 'takeover_and_wake', wakeScreen: true, piercesNightMode: true })],
      1000,
    );
    expect(push).toMatchObject({
      type: 'INTERRUPT_PUSH',
      protocol: PUSH_PROTOCOL_VERSION,
      sentAt: 1000,
      wakeScreen: true,
    });
  });

  it('follows the action, not the night-mode flag', () => {
    /*
     * Two different questions. Waking is about a screen that is dark for any
     * reason; piercing night mode is about the hours a household said to stay
     * quiet. Anding them made `takeover_and_wake` with `piercesNightMode:
     * false` a silent no-op — a combination somebody could set and never work
     * out. Both fields travel on every interrupt, so an app that wants to
     * respect night hours has what it needs.
     */
    const push = interruptPush(
      [interrupt({ action: 'takeover_and_wake', wakeScreen: true, piercesNightMode: false })],
      1000,
    );
    expect(push.wakeScreen).toBe(true);
    expect(push.interrupts[0]?.piercesNightMode).toBe(false);
  });

  it('is quiet when nothing asked to wake anybody', () => {
    expect(interruptPush([interrupt(), interrupt()], 1).wakeScreen).toBe(false);
    expect(interruptPush([], 1).wakeScreen).toBe(false);
  });

  it('sends the whole set rather than a delta', () => {
    /*
     * A client that missed a message must not be left holding a warning that
     * has been cancelled. Sending the set makes a dropped message cost latency
     * and nothing else, which on a wall is the right trade every time.
     */
    const push = interruptPush([interrupt({ key: 'a' }), interrupt({ key: 'b' })], 1);
    expect(push.interrupts.map((entry) => entry.key)).toEqual(['a', 'b']);
  });
});
