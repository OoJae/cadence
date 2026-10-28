import { describe, expect, it } from 'vitest';
import type { RunnerStatus } from '../api/types';
import { hasFeature } from './features';

describe('runner features', () => {
  it('are what the status lists, and none for an older runner that lists nothing', () => {
    expect(hasFeature({ features: ['trial', 'quote'] }, 'quote')).toBe(true);
    expect(hasFeature({ features: ['trial'] }, 'quote')).toBe(false);
    expect(hasFeature({}, 'trial')).toBe(false);
    expect(hasFeature(undefined, 'trial')).toBe(false);
    expect(hasFeature(null, 'trial')).toBe(false);
  });

  it('ignore a malformed list', () => {
    expect(hasFeature({ features: 'trial' } as unknown as RunnerStatus, 'trial')).toBe(false);
  });
});
