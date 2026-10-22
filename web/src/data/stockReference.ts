/**
 * The "compare with a stock wallet send" column is filled from a Shape. By default it
 * is this reference profile: what a plain one-recipient send from a stock
 * zcash_client_backend 0.25 wallet (the library under Zodl) looks like on NU7
 * testnet, by construction: v6, Ironwood only, one payment plus change padded to two
 * actions, ZIP 317 fee, default expiry delta, anchor at target − 3.
 *
 * It is NOT a decoded Zodl transaction. To compare against a real one, open
 * /decode/<installment txid>?compare=<any other txid> and the column is filled from
 * the runner's decode of that transaction instead.
 */
import type { Shape } from '../api/types';

export interface ShapeProfile {
  shape: Shape;
  title: string;
  source: 'reference' | 'decoded';
  note: string;
}

export const STOCK_SEND_REFERENCE: ShapeProfile = {
  title: 'Stock wallet send (reference)',
  source: 'reference',
  note:
    'Expected shape of a one-recipient send from a stock zcash_client_backend 0.25 wallet at a nearby height, built by the same rules. ' +
    'A reference profile, not a decoded transaction: pass ?compare=<txid> to fill this column from a real decode.',
  shape: {
    txid: '',
    version: 'V6',
    branch_id: '77190ad9',
    lock_time: 0,
    expiry_height: 4529370,
    mined_height: 4529251,
    expiry_minus_mined: 119,
    transparent_inputs: 0,
    transparent_outputs: 0,
    sapling_spends: 0,
    sapling_outputs: 0,
    orchard_actions: 0,
    ironwood_actions: 2,
    ironwood_flags: 7,
    ironwood_value_balance: 10000,
    ironwood_anchor: '',
    anchor_heights: [4529247, 4529247],
    anchor_depths: [4, 4],
    ironwood_proof_bytes: 7264,
    zero_ovk_recoverable: 0,
    supplied_ovk_recoverable: 0,
  },
};
