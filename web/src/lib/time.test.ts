import { afterEach, describe, expect, it } from 'vitest';
import { formatDateTime } from './time';

const tz = process.env.TZ;
afterEach(() => {
  process.env.TZ = tz;
});

describe('dates and times', () => {
  it('name the time zone they are shown in', () => {
    // The live mainnet mandate's second installment (evidence/mainnet.md).
    const at = Date.UTC(2026, 10, 3, 17, 0, 27) / 1000;
    process.env.TZ = 'UTC';
    expect(formatDateTime(at)).toBe('3 Nov, 17:00:27 UTC');
    process.env.TZ = 'Asia/Kolkata';
    expect(formatDateTime(at)).toBe('3 Nov, 22:30:27 GMT+5:30');
  });
});
