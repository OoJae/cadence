import { describe, expect, it } from 'vitest';
import { roundTime } from '../../lib/drand';
import { aheadFor, rungWindow } from '../../lib/window';
import { zatToZecString } from '../../lib/zat';
import { MAINNET_SAMPLE, RUN1, RUN1_RELEASED_INDEX, RUN2, shortTxid, TOWER_RUNGS } from './data';

// The landing's copy states these as facts; each one is derived here from the data.
describe('landing facts', () => {
  it('run 1: three payments, two minutes apart', () => {
    expect(RUN1.rounds).toHaveLength(3);
    for (let i = 1; i < RUN1.rounds.length; i++) expect(roundTime(RUN1.rounds[i]!) - roundTime(RUN1.rounds[i - 1]!)).toBe(120);
  });

  it("run 1's ladders are the window formula's counts", () => {
    expect([60, 180, 300].map((t) => rungWindow(aheadFor(t)).rungs)).toEqual([...RUN1.rungs]);
    expect(rungWindow(aheadFor(30 * 86_400)).rungs).toBe(TOWER_RUNGS);
  });

  it('the released rung is the block after the tip, inside ladder 1', () => {
    expect(RUN1_RELEASED_INDEX).toBe(5);
    expect(RUN1_RELEASED_INDEX).toBeLessThan(RUN1.rungs[0]);
    expect(RUN1.mined[0]).toBe(RUN1.targets[0]);
  });

  it('run 2 returned 210,000 zats, which is 0.0021 TAZ', () => {
    expect(zatToZecString(RUN2.refundedZats)).toBe('0.0021');
    expect(RUN2.cancelHeight).toBeGreaterThan(RUN2.installment1Mined);
  });

  it('the mainnet sample is 200 blocks, and the same-shape class is a minority', () => {
    expect(MAINNET_SAMPLE.toHeight - MAINNET_SAMPLE.fromHeight + 1).toBe(200);
    expect(MAINNET_SAMPLE.sameShape).toBeLessThan(MAINNET_SAMPLE.total);
  });

  it('shortens txids the way the copy prints them', () => {
    expect(shortTxid(RUN1.txid1)).toBe('2f1154c7…c7006e');
    expect(shortTxid(RUN2.cancelTxid)).toBe('6594ea6c…f56de3');
  });
});
