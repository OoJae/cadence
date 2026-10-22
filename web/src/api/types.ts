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

export type SubscriptionStatus = 'active' | 'completed' | 'cancelled' | 'stalled';
export type InstallmentState = 'sealed' | 'due' | 'broadcast' | 'mined' | 'cancelled' | 'missed';

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
}

// ---------------------------------------------------------------- evidence

/** `GET /api/decode/:txid`: the public shape of a transaction (same fields as cadence-decode). */
export interface Shape {
  txid: string;
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
}

// ---------------------------------------------------------------- webhooks (runner → merchant)

export type WebhookEventType = 'invoice.confirmed' | 'invoice.expired' | 'invoice.cancelled';

/** Body the runner POSTs to the merchant, signed with `X-Cadence-Signature: t=…,v1=…`. */
export interface WebhookEvent {
  type: WebhookEventType;
  subscription_id: string;
  k: number;
  txid: string;
  amount_zat: number;
}

// ---------------------------------------------------------------- sandbox (not in api.md v0)

/**
 * Judge-sandbox endpoints. These are a proposed testnet-only extension: the mock
 * runner implements them; a production runner must not.
 */
export interface SandboxFundRequest {
  ua: string;
  amount_zat: number;
}
export interface SandboxFundResponse {
  txid: string;
  /** The block it will be mined in (it sits in the mempool until then). */
  mined_height: number;
}

export type CheatKind = 'open_early' | 'tamper_amount' | 'replay_after_cancel';

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
  stage: 'tlock' | 'signature' | 'double-spend' | null;
  /** Error lines, in the order the components print them. */
  log: string[];
}

/** Error body every endpoint uses for 4xx/5xx. */
export interface ApiErrorBody {
  error: string;
}
