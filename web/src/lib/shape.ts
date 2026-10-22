/**
 * Reading a cadence-decode Shape: the checks the S2 evidence asserts, and how each
 * field compares against a stock wallet send.
 */
import type { Shape } from '../api/types';
import { INSTALLMENT_FEE_ZAT } from './zat';

/** NU7 default expiry delta (blocks). */
export const DEFAULT_EXPIRY_DELTA = 120;
export const ANCHOR_DEPTH = 3;
/** Halo 2 proof bytes for n Orchard-family actions. */
export const proofBytesFor = (actions: number) => 2720 + 2272 * actions;

export const BRANCHES: Record<string, string> = {
  '77190ad9': 'NU7',
  c8e71055: 'NU6',
};

/** Target height implied by the default expiry delta. */
export const impliedTarget = (s: Shape) => s.expiry_height - DEFAULT_EXPIRY_DELTA;

/** Blocks between the implied target and the block that mined it. */
export const blocksLate = (s: Shape) => (s.mined_height ? s.mined_height - impliedTarget(s) : null);

/** Whether the anchor's height range contains target − 3, the stock wallet rule. */
export function anchorMatchesStockRule(s: Shape): boolean {
  const want = impliedTarget(s) - ANCHOR_DEPTH;
  return s.anchor_heights[0] <= want && want <= s.anchor_heights[1];
}

export interface ShapeCheck {
  id: string;
  label: string;
  pass: boolean;
  detail: string;
}

/** The invariants every Cadence installment must satisfy (evidence/S2-testnet.md). */
export function cadenceChecks(s: Shape): ShapeCheck[] {
  const actions = s.ironwood_actions;
  return [
    { id: 'v6', label: 'v6 transaction', pass: s.version === 'V6', detail: s.version },
    { id: 'lock', label: 'lock_time = 0', pass: s.lock_time === 0, detail: String(s.lock_time) },
    {
      id: 'transparent',
      label: 'No transparent inputs or outputs',
      pass: s.transparent_inputs === 0 && s.transparent_outputs === 0,
      detail: `${s.transparent_inputs} in / ${s.transparent_outputs} out`,
    },
    {
      id: 'sapling',
      label: 'No Sapling and no Orchard-pool actions',
      pass: s.sapling_spends === 0 && s.sapling_outputs === 0 && s.orchard_actions === 0,
      detail: `${s.sapling_spends} / ${s.sapling_outputs} / ${s.orchard_actions}`,
    },
    { id: 'actions', label: 'Exactly 2 Ironwood actions', pass: actions === 2, detail: String(actions) },
    { id: 'fee', label: 'ZIP 317 fee for 2 actions', pass: s.ironwood_value_balance === INSTALLMENT_FEE_ZAT, detail: `${s.ironwood_value_balance} zats` },
    {
      id: 'expiry',
      label: 'Default expiry delta (target + 120)',
      pass: s.mined_height === 0 || (s.expiry_minus_mined <= DEFAULT_EXPIRY_DELTA && s.expiry_minus_mined > 0),
      detail: s.mined_height ? `expiry − mined = ${s.expiry_minus_mined}` : 'not mined yet',
    },
    { id: 'anchor', label: 'Anchor consistent with target − 3', pass: anchorMatchesStockRule(s), detail: `heights ${s.anchor_heights[0]}–${s.anchor_heights[1]}` },
    { id: 'proof', label: 'Standard proof size', pass: s.ironwood_proof_bytes === proofBytesFor(actions), detail: `${s.ironwood_proof_bytes} bytes` },
    { id: 'zero-ovk', label: 'Nothing recoverable with the zero OVK', pass: s.zero_ovk_recoverable === 0, detail: `${s.zero_ovk_recoverable} of ${actions}` },
    { id: 'pocket-ovk', label: "Nothing recoverable with the pocket's OVKs", pass: s.supplied_ovk_recoverable === 0, detail: `${s.supplied_ovk_recoverable} of ${actions}` },
  ];
}

export type Comparison = 'same' | 'differs' | 'per-tx' | 'n/a';

/** Compares two values that a blending installment must share with a stock send. */
export function sameOrDiffers(a: unknown, b: unknown): Comparison {
  return JSON.stringify(a) === JSON.stringify(b) ? 'same' : 'differs';
}

/** True when the expiry is the default delta above the implied target (or the tx is unmined). */
export function defaultExpiry(s: Shape): boolean {
  return s.mined_height === 0 || (s.expiry_minus_mined > 0 && s.expiry_minus_mined <= DEFAULT_EXPIRY_DELTA);
}
