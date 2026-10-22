/**
 * A tiny, time-driven model of the NU7 testnet for the mock runner.
 *
 * Heights are a pure function of wall-clock time: before the page loaded, blocks are
 * spaced 25 s apart (the real NU7 cadence, so historical fixtures look right); from
 * page load on, the mock chain runs at 5 s blocks so the sandbox fits in a few
 * minutes. Every view in the app labels this as accelerated.
 */
import { seededHex } from '../lib/prng';

export const HISTORIC_BLOCK_SECS = 25;
export const MOCK_BLOCK_SECS = 5;
/** S2's last installment was mined at 4529263; the mock chain starts a little later. */
export const MOCK_START_HEIGHT = 4529263 + 41;

export type MockTxKind = 'faucet' | 'wallet' | 'cancel';

export interface MockTx {
  txid: string;
  kind: MockTxKind;
  /** Recipient UA (faucet/wallet payments into a pocket, or the payer's refund address). */
  to: string;
  value_zat: number;
  sent_at: number;
  target_height: number;
  mined_height: number;
  /** For a cancel: the pocket (by UFVK) whose note it spends. */
  spends_pocket?: string;
}

export class MockChain {
  readonly t0: number;
  readonly h0: number;
  readonly #txs = new Map<string, MockTx>();
  #seq = 0;

  constructor(t0: number, h0 = MOCK_START_HEIGHT) {
    this.t0 = Math.floor(t0);
    this.h0 = h0;
  }

  tipAt(t: number): number {
    if (t >= this.t0) return this.h0 + Math.floor((t - this.t0) / MOCK_BLOCK_SECS);
    return this.h0 - Math.ceil((this.t0 - t) / HISTORIC_BLOCK_SECS);
  }

  /** When block `h` arrives. tipAt(timeOfHeight(h)) === h. */
  timeOfHeight(h: number): number {
    if (h >= this.h0) return this.t0 + (h - this.h0) * MOCK_BLOCK_SECS;
    return this.t0 - (this.h0 - h) * HISTORIC_BLOCK_SECS;
  }

  /** Broadcasts at `now`; the transaction is mined in the next block. */
  send(tx: Omit<MockTx, 'txid' | 'sent_at' | 'target_height' | 'mined_height'>, now: number): MockTx {
    const target = this.tipAt(now) + 1;
    const full: MockTx = {
      ...tx,
      txid: seededHex(`${tx.kind}:${tx.to}:${now}:${this.#seq++}:${Math.random()}`),
      sent_at: now,
      target_height: target,
      mined_height: target,
    };
    this.#txs.set(full.txid, full);
    return full;
  }

  /** Registers a transaction that happened in the past (fixtures). */
  record(tx: MockTx): void {
    this.#txs.set(tx.txid, tx);
  }

  get(txid: string): MockTx | undefined {
    return this.#txs.get(txid);
  }

  paymentsTo(ua: string): MockTx[] {
    return [...this.#txs.values()].filter((t) => t.to === ua && t.kind !== 'cancel');
  }

  pocketSpend(ufvk: string): MockTx | undefined {
    return [...this.#txs.values()].find((t) => t.spends_pocket === ufvk);
  }

  all(): MockTx[] {
    return [...this.#txs.values()];
  }
}
