import { afterEach, describe, expect, it } from 'vitest';
import { formatDateTime, formatWindow } from './time';

const tz = process.env.TZ;
afterEach(() => {
  if (tz === undefined) delete process.env.TZ;
  else process.env.TZ = tz;
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

  it('write a window with its shared date once', () => {
    const at = Date.UTC(2026, 10, 3, 17, 0, 27) / 1000;
    process.env.TZ = 'UTC';
    expect(formatWindow(at, at + 21_600)).toBe('3 Nov, 17:00:27 UTC – 23:00:27 UTC');
    expect(formatWindow(at, at + 8 * 3600)).toBe('3 Nov, 17:00:27 UTC – 4 Nov, 01:00:27 UTC');
    expect(formatWindow(at, at)).toBe(formatDateTime(at));
  });
});
