/**
 * drand quicknet round arithmetic. Pure maths on public chain parameters: the app
 * never contacts drand (the runner does, over Tor, when a round has passed).
 *
 * Quicknet: https://drand.love, chain 52db9ba7…e971, genesis 2023-08-23T15:09:27Z,
 * one round every 3 seconds, unchained BLS signatures on G1 (what tlock needs).
 */
export interface DrandChain {
  hash: string;
  genesisTime: number;
  period: number;
}

export const QUICKNET: DrandChain = {
  hash: '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971',
  genesisTime: 1692803367,
  period: 3,
};

/** The latest round whose time has come at `unixSecs` (drand's CurrentRound). 0 before genesis. */
export function roundAt(unixSecs: number, chain: DrandChain = QUICKNET): number {
  if (unixSecs < chain.genesisTime) return 0;
  return Math.floor((unixSecs - chain.genesisTime) / chain.period) + 1;
}

/** When `round` is published (drand's TimeOfRound). */
export function roundTime(round: number, chain: DrandChain = QUICKNET): number {
  if (!Number.isSafeInteger(round) || round < 1) throw new RangeError(`bad drand round ${round}`);
  return chain.genesisTime + (round - 1) * chain.period;
}

/** The first round published at or after `unixSecs`: what to time-lock to for "not before t". */
export function firstRoundAtOrAfter(unixSecs: number, chain: DrandChain = QUICKNET): number {
  if (unixSecs <= chain.genesisTime) return 1;
  return Math.ceil((unixSecs - chain.genesisTime) / chain.period) + 1;
}
