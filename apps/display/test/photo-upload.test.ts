import { describe, expect, it } from 'vitest';
import { LONG_SIDE, fitSize } from '../src/photo-upload.js';

/** The size a photo is drawn at before it is sent (plan item M3.1, MQ2). */
describe('fitSize', () => {
  it('leaves a photo no longer than a wall needs as it is', () => {
    expect(fitSize(1920, 1080)).toEqual({ width: 1920, height: 1080 });
    expect(fitSize(LONG_SIDE, 100)).toEqual({ width: LONG_SIDE, height: 100 });
  });

  it('scales the long side to 2560 and keeps the shape, landscape and portrait', () => {
    expect(fitSize(4032, 3024)).toEqual({ width: 2560, height: 1920 });
    expect(fitSize(3024, 4032)).toEqual({ width: 1920, height: 2560 });
    expect(fitSize(12000, 1000)).toEqual({ width: 2560, height: 213 });
  });
});
