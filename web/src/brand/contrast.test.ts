import { describe, expect, it } from 'vitest';
import { contrast, grade, luminance } from './contrast';

describe('contrast', () => {
  it('matches the WCAG extremes', () => {
    expect(luminance('#000000')).toBe(0);
    expect(luminance('#ffffff')).toBeCloseTo(1, 10);
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 10);
    expect(contrast('#777777', '#777777')).toBe(1);
  });

  it('is symmetric', () => {
    expect(contrast('#0b0d0c', '#eceae3')).toBeCloseTo(contrast('#eceae3', '#0b0d0c'), 12);
  });

  it('reproduces the brand pairings', () => {
    expect(contrast('#eceae3', '#0b0d0c')).toBeCloseTo(16.2, 1); // Ledger on Vault
    expect(contrast('#8b8f87', '#0b0d0c')).toBeCloseTo(5.9, 1); // Graphite on Vault (the plan said 6.4)
    expect(contrast('#171917', '#f3f0e8')).toBeCloseTo(15.5, 1); // Ink on Paper
    expect(grade(contrast('#2b322e', '#0b0d0c'))).toBe('Decorative'); // Hairline is never text
    expect(grade(contrast('#b07800', '#f3f0e8'))).toBe('AA large'); // light Release graphics
  });

  it('rejects anything but #rrggbb', () => {
    expect(() => luminance('#fff')).toThrow(RangeError);
  });
});
