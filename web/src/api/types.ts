/**
 * Wire types for the Cadence runner HTTP API v0 (docs/api.md).
 * Amounts are zatoshis, heights are block heights, times are unix seconds and a
 * `round` is a drand quicknet round number.
 */
import type { NetworkId } from '../lib/zat';

export type { NetworkId };

// ---------------------------------------------------------------- offers

/** Body of `POST /api/offers` (merchant, bearer token). */
export interface CreateOfferRequest {
  name: string;
  amount_zat: number;
  period_secs: number;
  count: number;
  /** The merchant's Orchard-only unified address. */
  merchant_ua: string;
}

/** `201` response of `POST /api/offers`. `share_url` carries the offer in its fragment. */
export interface CreateOfferResponse {
  offer_id: string;
  share_url: string;
}

/** `GET /api/offers/:id`: the offer the payer app signs against. */
export interface Offer {
  offer_id: string;
  name: string;
  amount_zat: number;
  period_secs: number;
  count: number;
  merchant_ua: string;
  /** age X25519 recipient: packages are sealed to the runner with this. */
  runner_age_recipient: string;
  /** https://… or http://….onion */
  runner_endpoint: string;
  network: NetworkId;
  /** drand chain hash the installments are time-locked to (quicknet). */
  drand_chain: string;
}

// ---------------------------------------------------------------- subscriptions

/** One pre-signed installment as uploaded: base64 tlock(age(zstd(ladder_k))). */
export interface SealedInstallment {
  k: number;
  release_round: number;
  sealed: string;
}

/** Body of `POST /api/subscriptions`, sent by the payer app after it pre-signs the ladder. */
export interface CreateSubscriptionRequest {
  offer_id: string;
  /** The pocket registered with `POST /api/pockets` (the WASM signer registers one; the mock does not). */
  pocket_id?: string;
  /** The pocket's Orchard-only UFVK. View-only, scoped to this one subscription. */
  pocket_ufvk: string;
  birthday_height: number;
  funding_txid: string;
  installments: SealedInstallment[];
}

export interface CreateSubscriptionResponse {
  subscription_id: string;
  status: 'active';
}

export type SubscriptionStatus = 'active' | 'completed' | 'cancelled' | 'stopped' | 'stalled';
export type InstallmentState = 'sealed' | 'due' | 'broadcast' | 'mined' | 'cancelled' | 'missed' | 'invalid';

export interface Installment {
  k: number;
  amount_zat: number;
  release_round: number;
  release_at: number;
  state: InstallmentState;
  txid?: string;
  target_height?: number;
  mined_height?: number;
}

export interface Subscription {
  subscription_id: string;
  offer_id: string;
  status: SubscriptionStatus;
  created_at: number;
  funding: { txid: string; mined_height: number; amount_zat: number };
  installments: Installment[];
  /** v2, `refund_after_stop`: the runner kept a stopped or missed subscription's pocket, and a note is left in it to refund. */
  refundable?: boolean;
  /** v2, `refund_after_stop`: the refund the runner saw spend that note. */
  refund?: { txid: string; mined_height: number };
}

// ---------------------------------------------------------------- payer pockets

/** Body of `POST /api/pockets`: ask the runner to watch a pocket (the browser has no chain access). */
export interface RegisterPocketRequest {
  pocket_ufvk: string;
}

/** `201` response of `POST /api/pockets`. */
export interface RegisterPocketResponse {
  pocket_id: string;
  birthday_height: number;
  tip: number;
}

/** The mined funding transaction, relayed raw so the app decrypts the note itself. */
export interface PocketFunding {
  txid: string;
  tx_hex: string;
  mined_height: number;
  value_zat: number;
}

/** An unspent note of the pocket, as the runner's view-only wallet sees it. */
export interface PocketNoteInfo {
  /** Hex of the note's 32-byte nullifier. */
  nullifier: string;
  value_zat: number;
  mined_height: number;
  position: number;
}

/**
 * `GET /api/pockets/:id`. `funding` is null until the funding transaction is mined.
 * Once the subscription ends the runner deletes the pocket's data: `funding.tx_hex`
 * is then "" and `notes` is [].
 */
export interface PocketState {
  pocket_id: string;
  tip: number;
  birthday_height?: number;
  /** The runner's wallet has not yet scanned the block of the latest mined installment, so that installment's change is not listed yet. */
  syncing?: boolean;
  funding: PocketFunding | null;
  notes: PocketNoteInfo[];
}

/** `GET /api/pockets/:id/witness?nullifier=…`: what the browser needs to prove a cancel. */
export interface PocketWitness {
  target_height: number;
  anchor_height: number;
  /** Hex of the 32-byte Ironwood tree root at `anchor_height`. */
  anchor: string;
  position: number;
  /** 32 sibling hashes, leaf first, each hex of 32 bytes. */
  auth_path: string[];
}

/** Body of `POST /api/broadcast`. */
export interface BroadcastRequest {
  tx_hex: string;
}

export interface BroadcastResponse {
  txid: string;
}

// ---------------------------------------------------------------- evidence

/** `GET /api/decode/:txid`: the public shape of a transaction (same fields as cadence-decode). */
export interface Shape {
  txid: string;
  /** Hex, one per Ironwood action: the nullifiers the transaction reveals (decode endpoint only). */
  ironwood_nullifiers?: string[];
  version: string;
  branch_id: string;
  lock_time: number;
  expiry_height: number;
  mined_height: number;
  expiry_minus_mined: number;
  transparent_inputs: number;
  transparent_outputs: number;
  sapling_spends: number;
  sapling_outputs: number;
  orchard_actions: number;
  ironwood_actions: number;
  ironwood_flags: number;
  ironwood_value_balance: number;
  ironwood_anchor: string;
  /** The range of heights whose Ironwood tree root equals the anchor. */
  anchor_heights: [number, number];
  /** `mined_height` minus that range: how deep the anchor sat when mined. */
  anchor_depths: [number, number];
  ironwood_proof_bytes: number;
  zero_ovk_recoverable: number;
  supplied_ovk_recoverable: number;
}

/** `GET /api/status`. */
export interface RunnerStatus {
  network: NetworkId;
  tip: number;
  drand_round: number;
  subscriptions: number;
  /** True when this runner serves the testnet-only `/api/sandbox` endpoints. */
  sandbox?: boolean;
  /** v2: what this runner implements beyond v0 (contract v2 §1). Absent on older runners, which means none. */
  features?: string[];
}

// ---------------------------------------------------------------- webhooks (runner → merchant)

export type WebhookEventType = 'invoice.confirmed' | 'invoice.expired' | 'invoice.cancelled';

/**
 * Part of the body the runner POSTs to the merchant. Unused by the app, which never
 * receives webhooks; docs/api.md ("Webhooks") has every field (`event`, `delivery_id`,
 * `offer_id`, `mined_height`, a nullable `txid`) and both signature headers.
 */
export interface WebhookEvent {
  type: WebhookEventType;
  subscription_id: string;
  k: number;
  txid: string;
  amount_zat: number;
}

// ---------------------------------------------------------------- sandbox (docs/api.md, "Testnet sandbox")

/**
 * Judge-sandbox endpoints, testnet only. The real runner serves them only when started
 * with --sandbox-funder on testnet; the mock runner implements them too.
 */
export interface SandboxFundRequest {
  ua: string;
  amount_zat: number;
}
export interface SandboxFundResponse {
  txid: string;
  /** The block it was mined in, if known (a real runner answers while it is still in the mempool). */
  mined_height: number | null;
}

export interface SandboxOfferRequest {
  count: number;
  period_secs: number;
  amount_zat: number;
}

/** `rebroadcast` was named `replay_after_cancel`; the runner still accepts the old name. */
export type CheatKind = 'open_early' | 'tamper_amount' | 'rebroadcast' | 'stretch_schedule';

export interface SandboxCheatRequest {
  subscription_id: string;
  kind: CheatKind;
  k: number;
}

export interface SandboxCheatResponse {
  kind: CheatKind;
  k: number;
  /** `rejected` is the expected outcome. `not_applicable` means the precondition is not met yet. */
  outcome: 'rejected' | 'not_applicable';
  /** Which defence stopped it. */
  stage: 'tlock' | 'signature' | 'double-spend' | 'schedule' | null;
  /** Error lines, in the order the components print them. */
  log: string[];
}

/** Error body every endpoint uses for 4xx/5xx. */
export interface ApiErrorBody {
  error: string;
}
