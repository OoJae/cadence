/**
 * Every number the landing shows, with where it comes from. Nothing here is invented:
 * if a figure isn't in this file, it isn't on the page.
 */

/** Testnet run 1: evidence/E2E-service-testnet.md, lines 10-18. */
export const RUN1 = {
  date: '22 Oct 2026',
  /** Funding mined at this height; taken as the signing tip (the tip itself isn't on file). */
  fundingHeight: 4_529_464,
  /** Rungs per installment (offsets 60, 180 and 300 s; lib/window.ts reproduces them). */
  rungs: [157, 167, 175] as const,
  rounds: [33_293_711, 33_293_751, 33_293_791] as const,
  targets: [4_529_470, 4_529_476, 4_529_483] as const,
  mined: [4_529_470, 4_529_480, 4_529_488] as const,
  txid1: '2f1154c7f02916d5c2f36a5091ca39077eb9ba01a3f7b3a29f6aee0540c7006e',
  /** Every sealed package is exactly this size. */
  packageKiB: 64,
} as const;

/** Index of installment 1's released rung above the ladder's base (start = signing tip + 1). */
export const RUN1_RELEASED_INDEX = RUN1.mined[0] - (RUN1.fundingHeight + 1);

/** Testnet run 2, cancelled: evidence/E2E-service-testnet.md, line 30. */
export const RUN2 = {
  date: '22 Oct 2026',
  installment1Mined: 4_529_503,
  cancelTxid: '6594ea6cf9d773b9afc11a8e8628328393eace24c5297f33bdb3dd637df56de3',
  cancelHeight: 4_529_506,
  refundedZats: 210_000,
  count: 3,
} as const;

/** Rungs for a payment due 30 days after signing, at 25 s blocks (spec table, lines 281-284). */
export const TOWER_RUNGS = 5844;

/** evidence/fingerprint-mainnet-sample.json: 200 mainnet blocks. */
export const MAINNET_SAMPLE = {
  fromHeight: 3_526_581,
  toHeight: 3_526_780,
  sameShape: 168,
  total: 521,
} as const;

/** A real S2 testnet installment the decoder ships offline (web/src/data/s2.ts). */
export const S2_TXID = '7ae2c96a9ca13ba42097236766582cab0c5c4809777c966c2bdb50e46597e790';

/** Flip to true only once a mainnet mandate is really running. */
export const MAINNET_LIVE = false;

export const shortTxid = (txid: string): string => `${txid.slice(0, 8)}…${txid.slice(-6)}`;
export const fmt = (n: number): string => n.toLocaleString('en-US');
