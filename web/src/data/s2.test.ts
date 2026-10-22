import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { anchorMatchesStockRule, cadenceChecks } from '../lib/shape';
import { S2_RUN, S2_SHAPES } from './s2';
import { STOCK_SEND_REFERENCE } from './stockReference';

const evidence = fileURLToPath(new URL('../../../evidence/s2-testnet-decoded.json', import.meta.url));

describe('S2 evidence', () => {
  it.skipIf(!existsSync(evidence))('matches evidence/s2-testnet-decoded.json byte for byte', () => {
    // cadence-decode prints one JSON object per transaction, back to back.
    const text = readFileSync(evidence, 'utf8');
    const parsed = JSON.parse(`[${text.trim().replace(/}\s*{/g, '},{')}]`);
    expect(parsed).toEqual(S2_SHAPES);
  });

  it('every real installment passes every Cadence invariant', () => {
    for (const s of S2_SHAPES) {
      const failed = cadenceChecks(s).filter((c) => !c.pass);
      expect(failed).toEqual([]);
    }
  });

  it('anchors sit where the runner put them: target − 3', () => {
    for (const [i, s] of S2_SHAPES.entries()) {
      const run = S2_RUN.installments[i]!;
      expect(s.expiry_height - 120).toBe(run.target_height);
      expect(run.anchor_height).toBe(run.target_height - 3);
      expect(anchorMatchesStockRule(s)).toBe(true);
    }
  });

  it('the stock reference profile is internally consistent', () => {
    expect(cadenceChecks(STOCK_SEND_REFERENCE.shape).every((c) => c.pass)).toBe(true);
  });
});
