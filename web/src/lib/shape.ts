/**
 * Reading a cadence-decode Shape: the checks the S2 evidence asserts, and how each
 * field compares against a stock wallet send.
 *
 * The rules depend on the network, the consensus branch and the target height, as in
 * crates/cadence-core (rung::fee_rule_at, mandate::installment_fee_at) and
 * zcash_primitives' default_tx_expiry_delta: an installment signed before NU7 expires
 * 40 blocks after its target, one signed for NU7 120 blocks after it, and on mainnet
 * an installment targeting 3,590,000 or later pays ZIP 2009's lower fee.
 *
 * A Shape from a real runner has null where a field does not apply (an unmined
 * transaction has no mined height or anchor range), so every reader here tolerates it.
 */
import type { NetworkId, Shape } from '../api/types';

export const NU7_BRANCH_ID = '77190ad9';
export const NU6_3_BRANCH_ID = '37a5165b';

/** Consensus branch ids as cadence-decode prints them (zcash_protocol 0.11 BranchId). */
export const BRANCHES: Record<string, string> = {
  '5ba81b19': 'Overwinter',
  '76b809bb': 'Sapling',
  '2bb40e60': 'Blossom',
  f5b9230b: 'Heartwood',
  e9ff75a6: 'Canopy',
  c2d6d0b4: 'NU5',
  c8e71055: 'NU6',
  '4dec4df0': 'NU6.1',
  '5437f330': 'NU6.2',
  [NU6_3_BRANCH_ID]: 'NU6.3',
  [NU7_BRANCH_ID]: 'NU7',
};

/** Activation heights from NU5 on, oldest first (zcash_protocol 0.11). Testnet is past NU7. */
const ACTIVATIONS: Record<NetworkId, Array<[height: number, branch: string]>> = {
  main: [
    [1_687_104, 'c2d6d0b4'],
    [2_726_400, 'c8e71055'],
    [3_146_400, '4dec4df0'],
    [3_364_600, '5437f330'],
    [3_428_143, NU6_3_BRANCH_ID],
    [3_543_405, NU7_BRANCH_ID],
  ],
  test: [
    [1_842_420, 'c2d6d0b4'],
    [2_976_000, 'c8e71055'],
    [3_536_500, '4dec4df0'],
    [4_052_000, '5437f330'],
    [4_134_000, NU6_3_BRANCH_ID],
    [4_465_026, NU7_BRANCH_ID],
  ],
};

/** The height NU7 activates at on each network. */
export const NU7_ACTIVATION: Record<NetworkId, number> = { main: 3_543_405, test: 4_465_026 };

/** From this mainnet target height an installment pays 1,000 zats per action (cadence-core MAINNET_FEE_SWITCH). */
export const MAINNET_FEE_SWITCH = 3_590_000;

/** Default expiry deltas in blocks: 40 from Blossom, 120 from NU7 (ZIP 218: the same 50 minutes at 25 s blocks). */
export const PRE_NU7_EXPIRY_DELTA = 40;
export const NU7_EXPIRY_DELTA = 120;
/** The NU7 delta, which every testnet installment uses. A decoded transaction's delta follows its branch: see expiryDeltaFor. */
export const DEFAULT_EXPIRY_DELTA = NU7_EXPIRY_DELTA;
export const ANCHOR_DEPTH = 3;
/** Halo 2 proof bytes for n Orchard-family actions. */
export const proofBytesFor = (actions: number) => 2720 + 2272 * actions;

/** The branch a transaction targeting `height` is signed for, or null below NU5. */
export function branchAt(network: NetworkId, height: number): string | null {
  let branch: string | null = null;
  for (const [h, b] of ACTIVATIONS[network]) if (height >= h) branch = b;
  return branch;
}

/** zcash_primitives default_tx_expiry_delta for a branch id, or null for one this app does not know. */
export function expiryDeltaFor(branchId: string): number | null {
  const name = BRANCHES[branchId];
  if (!name) return null;
  if (name === 'NU7') return NU7_EXPIRY_DELTA;
  if (name === 'Overwinter' || name === 'Sapling') return 20;
  return PRE_NU7_EXPIRY_DELTA;
}

/** ZIP 317 marginal fee per action at a target height: 5,000 zats, or 1,000 on mainnet from the ZIP 2009 switch. */
export function marginalFeeAt(network: NetworkId, height: number): number {
  return network === 'main' && height >= MAINNET_FEE_SWITCH ? 1_000 : 5_000;
}

/** The fee of an installment (two actions) targeting `height`: mandate::installment_fee_at. */
export function installmentFeeAt(network: NetworkId, height: number): number {
  return 2 * marginalFeeAt(network, height);
}

/** "ZIP 317" before the mainnet fee switch, "ZIP 2009" after it. */
export function feeRuleName(network: NetworkId, height: number): string {
  return marginalFeeAt(network, height) === 1_000 ? 'ZIP 2009' : 'ZIP 317';
}

/**
 * The target height a stock wallet built this for: expiry minus the default delta of
 * its branch. Null with no expiry, or for a branch this app does not know.
 */
export function impliedTarget(s: Shape): number | null {
  const delta = expiryDeltaFor(s.branch_id);
  if (!s.expiry_height || delta === null) return null;
  return s.expiry_height - delta;
}

/** Blocks between the implied target and the block that mined it. */
export function blocksLate(s: Shape): number | null {
  const target = impliedTarget(s);
  return s.mined_height && target !== null ? s.mined_height - target : null;
}

/** Whether the anchor's height range contains target − 3, the stock wallet rule. */
export function anchorMatchesStockRule(s: Shape): boolean {
  const target = impliedTarget(s);
  if (target === null || !s.anchor_heights) return false;
  const want = target - ANCHOR_DEPTH;
  return s.anchor_heights[0] <= want && want <= s.anchor_heights[1];
}

/** True when the expiry is within the default delta of its branch above the mined height (or the tx is unmined). */
export function defaultExpiry(s: Shape): boolean {
  const delta = expiryDeltaFor(s.branch_id);
  if (delta === null) return false;
  if (!s.mined_height) return true;
  return s.expiry_minus_mined > 0 && s.expiry_minus_mined <= delta;
}

/** The fee a stock wallet pays for two actions at this transaction's target height, or null when the target is unknown. */
export function expectedFee(s: Shape, network: NetworkId): number | null {
  const target = impliedTarget(s);
  return target === null ? null : installmentFeeAt(network, target);
}

export interface ShapeCheck {
  id: string;
  label: string;
  pass: boolean;
  detail: string;
}

/**
 * The invariants every Cadence installment must satisfy (evidence/S2-testnet.md).
 * `network` is the network the transaction was decoded from; the fee depends on it.
 */
export function cadenceChecks(s: Shape, network: NetworkId = 'test'): ShapeCheck[] {
  const actions = s.ironwood_actions;
  const target = impliedTarget(s);
  const delta = expiryDeltaFor(s.branch_id);
  const fee = expectedFee(s, network);
  const ruleName = target === null ? 'ZIP 317' : feeRuleName(network, target);
  const balance = s.ironwood_value_balance;
  const paid = balance == null ? 'no Ironwood value balance' : `${balance} zats`;
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
    {
      id: 'fee',
      label: `${ruleName} fee for 2 actions`,
      pass: fee !== null && balance === fee,
      detail: fee === null ? `${paid}; target height unknown` : balance === fee ? paid : `${paid}, expected ${fee}`,
    },
    {
      id: 'expiry',
      label: delta === null ? 'Default expiry delta' : `Default expiry delta (target + ${delta})`,
      pass: defaultExpiry(s),
      detail: delta === null ? `unknown branch ${s.branch_id}` : s.mined_height ? `expiry − mined = ${s.expiry_minus_mined}` : 'not mined yet',
    },
    {
      // The runner finds the anchor's heights only once the transaction is mined; like
      // the expiry check, an unmined transaction is not held against it.
      id: 'anchor',
      label: 'Anchor consistent with target − 3',
      pass: s.anchor_heights ? anchorMatchesStockRule(s) : !s.mined_height,
      detail: s.anchor_heights ? `heights ${s.anchor_heights[0]}–${s.anchor_heights[1]}` : s.mined_height ? 'no recent height has this anchor' : 'not mined yet',
    },
    { id: 'proof', label: 'Standard proof size', pass: s.ironwood_proof_bytes === proofBytesFor(actions), detail: s.ironwood_proof_bytes == null ? 'no Ironwood proof' : `${s.ironwood_proof_bytes} bytes` },
    { id: 'zero-ovk', label: 'Nothing recoverable with the zero OVK', pass: s.zero_ovk_recoverable === 0, detail: `${s.zero_ovk_recoverable} of ${actions}` },
    { id: 'pocket-ovk', label: "Nothing recoverable with the pocket's OVKs", pass: s.supplied_ovk_recoverable === 0, detail: `${s.supplied_ovk_recoverable} of ${actions}` },
  ];
}

/**
 * `reference` (a stock send) moved to `target` on `network`: the branch, expiry delta
 * and fee a stock wallet would use there, with its heights shifted by the same amount.
 */
export function stockShapeAt(reference: Shape, network: NetworkId, target: number): Shape {
  const from = impliedTarget(reference) ?? target;
  const shift = target - from;
  const branch = branchAt(network, target) ?? reference.branch_id;
  const expiry = target + (expiryDeltaFor(branch) ?? DEFAULT_EXPIRY_DELTA);
  const mined = reference.mined_height ? reference.mined_height + shift : 0;
  return {
    ...reference,
    branch_id: branch,
    expiry_height: expiry,
    mined_height: mined,
    expiry_minus_mined: mined ? expiry - mined : 0,
    ironwood_value_balance: installmentFeeAt(network, target),
    anchor_heights: reference.anchor_heights ? [reference.anchor_heights[0] + shift, reference.anchor_heights[1] + shift] : reference.anchor_heights,
  };
}

/** The few fields a status line shows for a mined installment. */
export interface ShapeSummary {
  /** "NU7", "NU6.3", or the raw branch id. */
  branch: string;
  /** The default expiry delta of that branch, or null for an unknown branch. */
  delta: number | null;
  fee: number | null;
  actions: number;
  passing: number;
  total: number;
}

export function summarizeShape(s: Shape, network: NetworkId): ShapeSummary {
  const checks = cadenceChecks(s, network);
  return {
    branch: BRANCHES[s.branch_id] ?? s.branch_id,
    delta: expiryDeltaFor(s.branch_id),
    fee: s.ironwood_value_balance ?? null,
    actions: s.ironwood_actions,
    passing: checks.filter((c) => c.pass).length,
    total: checks.length,
  };
}

export type Comparison = 'same' | 'differs' | 'per-tx' | 'n/a';

/** Compares two values that a blending installment must share with a stock send. */
export function sameOrDiffers(a: unknown, b: unknown): Comparison {
  return JSON.stringify(a) === JSON.stringify(b) ? 'same' : 'differs';
}
