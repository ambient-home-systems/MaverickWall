import { describe, expect, it } from 'vitest';
import { bootingBody, BOOTING_HTML } from '../src/http/booting-page.js';

/**
 * The bodies the boot holder serves. A browser gets a self-refreshing page that
 * keeps its URL (so a pairing token rides through), a poll or API caller a small
 * machine body, the health probe plain text — everything a transient 503.
 */
describe('the booting-page bodies', () => {
  it('gives a browser a self-contained, self-refreshing page', () => {
    const { contentType, body } = bootingBody('/pair');
    expect(contentType).toContain('text/html');
    expect(body).toBe(BOOTING_HTML);
    expect(body).toContain('booting');
    expect(body).toContain('http-equiv="refresh"');
    // Self-contained: no asset the holder would 503 anyway.
    expect(body).not.toContain('/assets/');
    expect(body).not.toMatch(/src="https?:/);
  });

  it('gives a poll or API caller JSON, not a page', () => {
    for (const path of ['/d/manifest', '/api/auth/session']) {
      const { contentType, body } = bootingBody(path);
      expect(contentType).toContain('application/json');
      expect(JSON.parse(body)).toEqual({
        error: 'booting',
        message: 'Maverick Wall server is booting. Calendar will be back soon.',
      });
    }
  });

  it('gives the health probe plain text', () => {
    const { contentType, body } = bootingBody('/healthz');
    expect(contentType).toContain('text/plain');
    expect(body).toBe('booting\n');
  });
});
