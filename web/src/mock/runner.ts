/**
 * An in-memory model of cadence-runner, for VITE_API=mock.
 *
 * Installment states are derived from time and chain events with the same rules the
 * real runner follows (crates/cadence-runner): an installment opens when its drand
 * round passes, waits until its input note is 3 blocks deep (anchor = target − 3),
 * is broadcast for target = tip + 1 only if the payer signed a rung for exactly that
 * height (else "missed"), and is "cancelled" if its input was spent elsewhere first.
 */
import type {
  CheatKind,
  CreateOfferRequest,
  CreateSubscriptionRequest,
  Installment,
  InstallmentState,
  Offer,
  RunnerStatus,
  SandboxCheatResponse,
  Shape,
  Subscription,
  SubscriptionStatus,
} from '../api/types';
import { isUfvk, isUnifiedAddress, shorten } from '../lib/addresses';
import { QUICKNET, roundAt, roundTime } from '../lib/drand';
import { buildShareUrl, LIMITS } from '../lib/offer';
import { seededBech32, seededHex, seededInt } from '../lib/prng';
import { INSTALLMENT_FEE_ZAT, MAX_MONEY_ZAT, totalPrepaidZat } from '../lib/zat';
import { findS2Shape } from '../data/s2';
import type { MockChain, MockTx } from './chain';

/** NU7 default expiry delta. */
export const EXPIRY_DELTA = 120;
/** Stock wallets anchor at target − 3. */
export const ANCHOR_CONFIRMATIONS = 3;
/** Poll interval plus sync plus proving: how long after its round the runner acts. */
export const RUNNER_LATENCY_SECS = 4;

export interface MockInstallmentRecord {
  k: number;
  amount_zat: number;
  release_round: number;
  /** Rung target heights the payer signed. The runner learns them when the package opens. */
  window: [number, number] | null;
  /** Blocks the network takes beyond the target to mine it (testnet jitter). */
  late: number;
  /** Fixture: the runner was down until this time, so it acts late. */
  runner_offline_until?: number;
  /** Fixtures with real on-chain data bypass derivation. */
  fixed?: Required<Pick<Installment, 'state' | 'txid' | 'target_height' | 'mined_height'>>;
}

export interface MockSubRecord {
  subscription_id: string;
  offer: Offer;
  created_at: number;
  funding: { txid: string; mined_height: number; amount_zat: number };
  pocket_ufvk: string;
  installments: MockInstallmentRecord[];
  stopped_at?: number;
  /** Shown in the dashboard: where a fixture's data comes from. */
  provenance?: string;
}

export interface DerivedInstallment extends Installment {
  /** When the runner broadcast it (or will), if it gets that far. */
  broadcast_at?: number;
  anchor_height?: number;
  input_mined_height?: number;
}

export interface Derived {
  subscription: Subscription;
  detail: DerivedInstallment[];
}

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type Blocked = { kind: 'cancel' | 'stop'; effective_at: number } | { kind: 'missed' };

/** Pure derivation of a subscription's public state at time `now`. */
export function deriveSubscription(rec: MockSubRecord, chain: MockChain, now: number): Derived {
  const tipNow = chain.tipAt(now);
  const cancelTx = chain.pocketSpend(rec.pocket_ufvk);
  const fundingMined = rec.funding.mined_height <= tipNow;
  let inputMined: number | undefined = fundingMined ? rec.funding.mined_height : undefined;
  let blocked: Blocked | null = null;
  const detail: DerivedInstallment[] = [];

  for (const [idx, inst] of rec.installments.entries()) {
    const release_at = roundTime(inst.release_round);
    const base = { k: inst.k, amount_zat: inst.amount_zat, release_round: inst.release_round, release_at };

    if (inst.fixed) {
      detail.push({ ...base, ...inst.fixed });
      inputMined = inst.fixed.mined_height;
      continue;
    }

    if (blocked) {
      let state: InstallmentState;
      if (blocked.kind === 'missed') state = now < release_at ? 'sealed' : 'missed';
      else state = now >= blocked.effective_at ? 'cancelled' : now < release_at ? 'sealed' : 'due';
      detail.push({ ...base, state });
      continue;
    }

    if (inputMined === undefined) {
      // Input not on chain yet (the funding transaction is still in the mempool): this
      // installment and every later one waits ("input not yet on chain, waiting").
      for (const rest of rec.installments.slice(idx)) {
        const ra = roundTime(rest.release_round);
        detail.push({ k: rest.k, amount_zat: rest.amount_zat, release_round: rest.release_round, release_at: ra, state: now < ra ? 'sealed' : 'due' });
      }
      break;
    }

    // The runner broadcasts once the round has passed and the input is 3 deep:
    // input mined at M is usable for target T when M <= T - 3, i.e. tip >= M + 2.
    const acts_at = Math.max(release_at + RUNNER_LATENCY_SECS, inst.runner_offline_until ?? 0);
    let bTip = Math.max(chain.tipAt(acts_at), inputMined + ANCHOR_CONFIRMATIONS - 1);
    if (inst.window) bTip = Math.max(bTip, inst.window[0] - 1);
    const broadcast_at = Math.max(acts_at, chain.timeOfHeight(bTip));
    const target = bTip + 1;

    const stopAt = rec.stopped_at ?? Infinity;
    if (stopAt <= broadcast_at) {
      blocked = { kind: 'stop', effective_at: stopAt };
      detail.push({ ...base, state: now >= stopAt ? 'cancelled' : now < release_at ? 'sealed' : 'due' });
      continue;
    }
    if (cancelTx && cancelTx.sent_at <= broadcast_at) {
      const effective_at = chain.timeOfHeight(cancelTx.mined_height);
      blocked = { kind: 'cancel', effective_at };
      detail.push({ ...base, state: now >= effective_at ? 'cancelled' : now < release_at ? 'sealed' : 'due' });
      continue;
    }
    if (inst.window && target > inst.window[1]) {
      blocked = { kind: 'missed' };
      detail.push({ ...base, state: now < release_at ? 'sealed' : now < broadcast_at ? 'due' : 'missed', target_height: now >= broadcast_at ? target : undefined });
      continue;
    }

    const mined = target + inst.late;
    const txid = seededHex(`${rec.subscription_id}:installment:${inst.k}`);
    const extra = { broadcast_at, anchor_height: target - ANCHOR_CONFIRMATIONS, input_mined_height: inputMined };
    if (now < release_at) detail.push({ ...base, state: 'sealed' });
    else if (now < broadcast_at) detail.push({ ...base, state: 'due', ...extra });
    else if (tipNow < mined) detail.push({ ...base, state: 'broadcast', txid, target_height: target, ...extra });
    else detail.push({ ...base, state: 'mined', txid, target_height: target, mined_height: mined, ...extra });
    inputMined = mined;
  }

  const states = detail.map((d) => d.state);
  let status: SubscriptionStatus = 'active';
  if (states.includes('cancelled')) status = 'cancelled';
  else if (states.includes('missed')) status = 'stalled';
  else if (states.every((s) => s === 'mined')) status = 'completed';

  const subscription: Subscription = {
    subscription_id: rec.subscription_id,
    offer_id: rec.offer.offer_id,
    status,
    created_at: rec.created_at,
    funding: { txid: rec.funding.txid, mined_height: fundingMined ? rec.funding.mined_height : 0, amount_zat: rec.funding.amount_zat },
    installments: detail.map(({ k, amount_zat, release_round, release_at, state, txid, target_height, mined_height }) => {
      const i: Installment = { k, amount_zat, release_round, release_at, state };
      if (txid) i.txid = txid;
      if (target_height !== undefined) i.target_height = target_height;
      if (mined_height !== undefined) i.mined_height = mined_height;
      return i;
    }),
  };
  return { subscription, detail };
}

/** A plausible public shape for a mock 2-action Ironwood transaction (same rules as S2). */
export function synthShape(txid: string, target: number, mined: number): Shape {
  const expiry = target + EXPIRY_DELTA;
  const anchor = target - ANCHOR_CONFIRMATIONS;
  const lo = anchor - seededInt(`${txid}:lo`, 2);
  let hi = anchor + seededInt(`${txid}:hi`, 3);
  hi = Math.min(hi, target - 1, mined ? mined - 1 : Infinity);
  return {
    txid,
    version: 'V6',
    branch_id: '77190ad9',
    lock_time: 0,
    expiry_height: expiry,
    mined_height: mined,
    expiry_minus_mined: mined ? expiry - mined : 0,
    transparent_inputs: 0,
    transparent_outputs: 0,
    sapling_spends: 0,
    sapling_outputs: 0,
    orchard_actions: 0,
    ironwood_actions: 2,
    ironwood_flags: 7,
    ironwood_value_balance: INSTALLMENT_FEE_ZAT,
    ironwood_anchor: seededHex(`${txid}:anchor`),
    anchor_heights: [lo, hi],
    anchor_depths: mined ? [mined - hi, mined - lo] : [0, 0],
    ironwood_proof_bytes: 2720 + 2272 * 2,
    // Every pocket output uses OvkPolicy::Discard: nothing is recoverable with the
    // all-zero OVK or with the pocket's own OVKs (which the runner holds).
    zero_ovk_recoverable: 0,
    supplied_ovk_recoverable: 0,
  };
}

const AUTH_REQUIRED = new HttpError(401, 'missing bearer token');

export class MockRunner {
  readonly chain: MockChain;
  readonly clock: () => number;
  readonly appOrigin: string;
  readonly ageRecipient: string;
  readonly offers = new Map<string, Offer>();
  readonly subs = new Map<string, MockSubRecord>();
  /** Rung windows, keyed by sealed package. Stands in for "the runner opens the package". */
  readonly #windows = new Map<string, [number, number]>();
  #seq = 0;

  constructor(chain: MockChain, clock: () => number, appOrigin: string) {
    this.chain = chain;
    this.clock = clock;
    this.appOrigin = appOrigin;
    this.ageRecipient = `age1${seededBech32('mock-runner-age', 58)}`;
  }

  // ------------------------------------------------ mock-only plumbing

  registerPackage(sealed: string, window: [number, number]): void {
    this.#windows.set(sealed, window);
  }

  /** In mock mode a share link opened in a fresh tab names an offer this in-memory runner never saw. */
  adoptOffer(offer: Offer): void {
    if (!this.offers.has(offer.offer_id)) this.offers.set(offer.offer_id, offer);
  }

  addRecord(rec: MockSubRecord): void {
    this.subs.set(rec.subscription_id, rec);
    this.offers.set(rec.offer.offer_id, rec.offer);
  }

  derive(id: string): Derived {
    const rec = this.subs.get(id);
    if (!rec) throw new HttpError(404, 'no such subscription');
    return deriveSubscription(rec, this.chain, this.clock());
  }

  /** What is left in a pocket: funding minus every installment that has left it. */
  pocketBalance(ufvk: string): number {
    const rec = [...this.subs.values()].find((r) => r.pocket_ufvk === ufvk);
    if (!rec) return 0;
    const { detail } = deriveSubscription(rec, this.chain, this.clock());
    const spent = detail
      .filter((d) => d.state === 'broadcast' || d.state === 'mined')
      .reduce((s, d) => s + d.amount_zat + INSTALLMENT_FEE_ZAT, 0);
    return Math.max(0, rec.funding.amount_zat - spent);
  }

  newOfferId(): string {
    return `off_${seededBech32(`offer:${this.clock()}:${this.#seq++}:${Math.random()}`, 12)}`;
  }

  // ------------------------------------------------ endpoints

  status(): RunnerStatus {
    const now = this.clock();
    return { network: 'test', tip: this.chain.tipAt(now), drand_round: roundAt(now), subscriptions: this.subs.size };
  }

  createOffer(body: unknown, token: string | undefined): { offer_id: string; share_url: string } {
    if (!token) throw AUTH_REQUIRED;
    const b = body as Partial<CreateOfferRequest> | null;
    if (!b || typeof b !== 'object') throw new HttpError(400, 'body must be a JSON object');
    if (typeof b.name !== 'string' || !b.name.trim() || b.name.length > LIMITS.nameMax) throw new HttpError(422, `name must be 1–${LIMITS.nameMax} characters`);
    if (!Number.isSafeInteger(b.amount_zat) || (b.amount_zat as number) < 1 || (b.amount_zat as number) > MAX_MONEY_ZAT) throw new HttpError(422, 'amount_zat must be a positive whole number');
    if (!Number.isSafeInteger(b.period_secs) || (b.period_secs as number) < LIMITS.periodMin || (b.period_secs as number) > LIMITS.periodMax) throw new HttpError(422, 'period_secs is out of range');
    if (!Number.isSafeInteger(b.count) || (b.count as number) < LIMITS.countMin || (b.count as number) > LIMITS.countMax) throw new HttpError(422, `count must be ${LIMITS.countMin}–${LIMITS.countMax}`);
    if (typeof b.merchant_ua !== 'string' || !isUnifiedAddress(b.merchant_ua, 'test')) throw new HttpError(422, 'merchant_ua must be a testnet unified address (utest1…) with an Orchard receiver');
    const offer: Offer = {
      offer_id: this.newOfferId(),
      name: b.name.trim(),
      amount_zat: b.amount_zat as number,
      period_secs: b.period_secs as number,
      count: b.count as number,
      merchant_ua: b.merchant_ua,
      runner_age_recipient: this.ageRecipient,
      runner_endpoint: this.appOrigin,
      network: 'test',
      drand_chain: QUICKNET.hash,
    };
    this.offers.set(offer.offer_id, offer);
    return { offer_id: offer.offer_id, share_url: buildShareUrl(this.appOrigin, offer) };
  }

  getOffer(id: string): Offer {
    const offer = this.offers.get(id);
    if (!offer) throw new HttpError(404, 'no such offer');
    return offer;
  }

  createSubscription(body: unknown): { subscription_id: string; status: 'active' } {
    const b = body as Partial<CreateSubscriptionRequest> | null;
    if (!b || typeof b !== 'object') throw new HttpError(400, 'body must be a JSON object');
    const offer = typeof b.offer_id === 'string' ? this.offers.get(b.offer_id) : undefined;
    if (!offer) throw new HttpError(404, 'no such offer');
    if (typeof b.pocket_ufvk !== 'string' || !isUfvk(b.pocket_ufvk, 'test')) throw new HttpError(422, 'pocket_ufvk must be a testnet UFVK');
    if ([...this.subs.values()].some((r) => r.pocket_ufvk === b.pocket_ufvk)) throw new HttpError(409, 'this pocket already backs a subscription; pockets are single-use');
    if (!Number.isSafeInteger(b.birthday_height)) throw new HttpError(422, 'birthday_height must be a height');
    const funding = typeof b.funding_txid === 'string' ? this.chain.get(b.funding_txid) : undefined;
    if (!funding || funding.kind === 'cancel') throw new HttpError(422, 'funding_txid is not a payment the runner can see');
    const need = totalPrepaidZat(offer.amount_zat, offer.count);
    if (funding.value_zat < need) throw new HttpError(422, `the funding note holds ${funding.value_zat} zats; this offer needs ${need}`);
    const list = Array.isArray(b.installments) ? b.installments : [];
    if (list.length !== offer.count) throw new HttpError(422, `expected ${offer.count} installments, got ${list.length}`);
    let lastRound = 0;
    const installments: MockInstallmentRecord[] = list.map((inst, i) => {
      if (!inst || inst.k !== i + 1) throw new HttpError(422, 'installments must be numbered 1…N in order');
      if (!Number.isSafeInteger(inst.release_round) || inst.release_round <= lastRound) throw new HttpError(422, 'release rounds must increase');
      if (typeof inst.sealed !== 'string' || inst.sealed.length < 64) throw new HttpError(422, `installment ${inst.k} has no sealed package`);
      lastRound = inst.release_round;
      return {
        k: inst.k,
        amount_zat: offer.amount_zat,
        release_round: inst.release_round,
        window: this.#windows.get(inst.sealed) ?? null,
        late: 0,
      };
    });
    const subscription_id = `sub_${seededBech32(`sub:${b.pocket_ufvk}`, 12)}`;
    this.subs.set(subscription_id, {
      subscription_id,
      offer,
      created_at: Math.floor(this.clock()),
      funding: { txid: funding.txid, mined_height: funding.mined_height, amount_zat: funding.value_zat },
      pocket_ufvk: b.pocket_ufvk,
      installments,
    });
    return { subscription_id, status: 'active' };
  }

  listSubscriptions(): Subscription[] {
    return [...this.subs.keys()]
      .map((id) => this.derive(id).subscription)
      .sort((a, b) => b.created_at - a.created_at);
  }

  getSubscription(id: string): Subscription {
    return this.derive(id).subscription;
  }

  stop(id: string, token: string | undefined): Subscription {
    if (!token) throw AUTH_REQUIRED;
    const rec = this.subs.get(id);
    if (!rec) throw new HttpError(404, 'no such subscription');
    const current = this.derive(id).subscription;
    if (current.status === 'completed' || current.status === 'cancelled') throw new HttpError(409, `the subscription is already ${current.status}`);
    rec.stopped_at = this.clock();
    return this.derive(id).subscription;
  }

  decode(txid: string): Shape {
    const s2 = findS2Shape(txid);
    if (s2) return s2;
    const tip = this.chain.tipAt(this.clock());
    for (const rec of this.subs.values()) {
      const { detail } = deriveSubscription(rec, this.chain, this.clock());
      const hit = detail.find((d) => d.txid === txid && d.target_height !== undefined);
      if (hit) return synthShape(txid, hit.target_height!, hit.mined_height ?? 0);
    }
    const tx: MockTx | undefined = this.chain.get(txid);
    if (tx) return synthShape(txid, tx.target_height, tx.mined_height <= tip ? tx.mined_height : 0);
    throw new HttpError(404, "transaction not found on the runner's node");
  }

  // ------------------------------------------------ sandbox extension

  fund(body: unknown): { txid: string; mined_height: number } {
    const b = body as { ua?: unknown; amount_zat?: unknown } | null;
    if (!b || typeof b.ua !== 'string' || !isUnifiedAddress(b.ua, 'test')) throw new HttpError(422, 'ua must be a testnet unified address');
    if (!Number.isSafeInteger(b.amount_zat) || (b.amount_zat as number) < 1 || (b.amount_zat as number) > 10 * 1e8) throw new HttpError(422, 'the sandbox faucet pays at most 10 TAZ');
    const tx = this.chain.send({ kind: 'faucet', to: b.ua, value_zat: b.amount_zat as number }, this.clock());
    return { txid: tx.txid, mined_height: tx.mined_height };
  }

  cheat(body: unknown): SandboxCheatResponse {
    const b = body as { subscription_id?: unknown; kind?: unknown; k?: unknown } | null;
    if (!b || typeof b.subscription_id !== 'string') throw new HttpError(422, 'subscription_id is required');
    const kind = b.kind as CheatKind;
    if (kind !== 'open_early' && kind !== 'tamper_amount' && kind !== 'replay_after_cancel') throw new HttpError(422, 'unknown cheat');
    const rec = this.subs.get(b.subscription_id);
    if (!rec) throw new HttpError(404, 'no such subscription');
    const now = this.clock();
    const { detail } = deriveSubscription(rec, this.chain, now);
    const inst = detail.find((d) => d.k === b.k);
    if (!inst) throw new HttpError(422, 'no such installment');
    const k = inst.k;
    const na = (line: string): SandboxCheatResponse => ({ kind, k, outcome: 'not_applicable', stage: null, log: [line] });

    if (kind === 'open_early') {
      if (inst.state !== 'sealed') return na(`installment ${k}: drand round ${inst.release_round} has already been published, so its package opens normally; pick a sealed installment`);
      const latest = roundAt(now);
      const ahead = inst.release_round - latest;
      return {
        kind,
        k,
        outcome: 'rejected',
        stage: 'tlock',
        log: [
          `installment ${k}: package is tlock-sealed to drand quicknet round ${inst.release_round}`,
          `drand ${QUICKNET.hash.slice(0, 8)}…: latest published round is ${latest}; round ${inst.release_round} is ${ahead} rounds (${ahead * QUICKNET.period} s) away`,
          `tlock: the decryption key for round ${inst.release_round} is drand's threshold BLS signature on that round, which no one holds yet`,
          `age: No matching keys found`,
        ],
      };
    }

    if (kind === 'tamper_amount') {
      if (inst.state === 'sealed') return na(`installment ${k} is still sealed; the runner cannot even read its amount before round ${inst.release_round}`);
      if (inst.state === 'cancelled' || inst.state === 'missed') return na(`installment ${k} is ${inst.state}; pick a due, broadcast or mined installment`);
      const bumped = inst.amount_zat * 10;
      return {
        kind,
        k,
        outcome: 'rejected',
        stage: 'signature',
        log: [
          `installment ${k}: rewriting the merchant output ${inst.amount_zat} → ${bumped} zats before proving`,
          `pczt: the output's value commitment (cv_net) and note commitment (cmx) change, and both are covered by the v6 sighash`,
          `extracting: the payer's spend authorization signature no longer verifies under rk for the new sighash, and the binding signature no longer balances`,
          `node: transaction rejected: invalid Ironwood spend authorization signature`,
        ],
      };
    }

    // replay_after_cancel
    const cancelTx = this.chain.pocketSpend(rec.pocket_ufvk);
    if (!cancelTx || cancelTx.mined_height > this.chain.tipAt(now)) return na('the pocket has not been cancelled on chain yet; cancel first, then replay');
    if (inst.state !== 'cancelled') return na(`installment ${k} was already ${inst.state} before the cancel; pick a cancelled installment`);
    const nf = seededHex(`${rec.subscription_id}:nf:${k}`);
    return {
      kind,
      k,
      outcome: 'rejected',
      stage: 'double-spend',
      log: [
        `installment ${k}: its input was spent elsewhere; mandate cancelled`,
        `replaying installment ${k}'s pre-signed bytes to a node directly instead`,
        `node: transaction rejected: Ironwood double-spend: nullifier ${shorten(nf, 12, 8)} was already revealed by ${shorten(cancelTx.txid, 12, 8)} at height ${cancelTx.mined_height}`,
      ],
    };
  }
}
