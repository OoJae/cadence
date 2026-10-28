import type {
  BroadcastRequest,
  BroadcastResponse,
  CreateOfferRequest,
  CreateOfferResponse,
  CreateSubscriptionRequest,
  CreateSubscriptionResponse,
  Offer,
  PassKey,
  PassResponse,
  PassVerifyResponse,
  PocketState,
  PocketWitness,
  RegisterPocketRequest,
  RegisterPocketResponse,
  RunnerFeature,
  RunnerStatus,
  SandboxCheatRequest,
  SandboxCheatResponse,
  SandboxFundRequest,
  SandboxFundResponse,
  Shape,
  Subscription, SandboxOfferRequest } from './types';
import type { PayerAuth } from '../lib/payerAuth';

export type Method = 'GET' | 'POST';

export interface ApiRequest {
  method: Method;
  /** Always starts with `/api/`. */
  path: string;
  body?: unknown;
  /** Merchant bearer token. Held by the caller in memory only. */
  token?: string;
  signal?: AbortSignal;
  /** Overrides the transport's default timeout, for large uploads. */
  timeoutMs?: number;
  /** Extra headers: the payer's signature (src/lib/payerAuth.ts). */
  headers?: Record<string, string>;
}

/** Something that can carry a request to a runner: `fetch`, or the in-memory mock. */
export interface Transport {
  readonly label: string;
  request<T>(req: ApiRequest): Promise<T>;
}

export class ApiError extends Error {
  readonly status: number;
  /** A 429's `Retry-After`, in seconds, when the runner sent one the page could read. */
  readonly retryAfterSecs?: number;
  constructor(status: number, message: string, retryAfterSecs?: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    if (retryAfterSecs !== undefined) this.retryAfterSecs = retryAfterSecs;
  }
}

/** The runner answered 429: it is up and rate limiting this client, so ask again later rather than fail. */
export function isBusy(e: unknown): e is ApiError {
  return e instanceof ApiError && e.status === 429;
}

/** How long a busy runner asked to be left alone, in ms, or `fallbackMs` when it did not say. */
export function busyWaitMs(e: ApiError, fallbackMs = 5_000): number {
  return e.retryAfterSecs !== undefined ? e.retryAfterSecs * 1000 : fallbackMs;
}

const TXID = /^[0-9a-f]{64}$/;
const HEX32 = /^[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9_-]{1,80}$/;

function idSegment(id: string, what: string): string {
  if (!ID.test(id)) throw new ApiError(400, `invalid ${what}`);
  return encodeURIComponent(id);
}

/** Typed client for every endpoint in docs/api.md. */
export class CadenceClient {
  readonly transport: Transport;

  constructor(transport: Transport) {
    this.transport = transport;
  }

  /** `POST /api/offers`: create a plan (merchant). */
  createOffer(body: CreateOfferRequest, token: string, signal?: AbortSignal): Promise<CreateOfferResponse> {
    return this.transport.request({ method: 'POST', path: '/api/offers', body, token, signal });
  }

  /** `GET /api/offers/:id`: the offer the payer signs against. */
  getOffer(offerId: string, signal?: AbortSignal): Promise<Offer> {
    return this.transport.request({ method: 'GET', path: `/api/offers/${idSegment(offerId, 'offer id')}`, signal });
  }

  /** `POST /api/subscriptions`: upload the sealed, pre-signed ladder (payer). */
  createSubscription(body: CreateSubscriptionRequest, signal?: AbortSignal): Promise<CreateSubscriptionResponse> {
    return this.transport.request({ method: 'POST', path: '/api/subscriptions', body, signal, timeoutMs: uploadTimeoutMs(body.installments) });
  }

  /** `POST /api/pockets`: ask the runner to watch a new pocket (payer, WASM signer). */
  registerPocket(body: RegisterPocketRequest, signal?: AbortSignal): Promise<RegisterPocketResponse> {
    return this.transport.request({ method: 'POST', path: '/api/pockets', body, signal });
  }

  /** `GET /api/pockets/:id`: tip, the raw funding transaction once mined, and unspent notes. */
  getPocket(pocketId: string, signal?: AbortSignal): Promise<PocketState> {
    return this.transport.request({ method: 'GET', path: `/api/pockets/${idSegment(pocketId, 'pocket id')}`, signal });
  }

  /** `GET /api/pockets/:id/witness?nullifier=`: anchor and authentication path to prove a cancel. */
  getPocketWitness(pocketId: string, nullifier: string, signal?: AbortSignal): Promise<PocketWitness> {
    const nf = nullifier.trim().toLowerCase();
    if (!HEX32.test(nf)) return Promise.reject(new ApiError(400, 'a nullifier is 64 hex characters'));
    return this.transport.request({ method: 'GET', path: `/api/pockets/${idSegment(pocketId, 'pocket id')}/witness?nullifier=${nf}`, signal });
  }

  /** `POST /api/broadcast`: relay a finished transaction (the browser's cancel). */
  broadcast(body: BroadcastRequest, signal?: AbortSignal): Promise<BroadcastResponse> {
    return this.transport.request({ method: 'POST', path: '/api/broadcast', body, signal });
  }

  /** `GET /api/subscriptions`. Accepts a bare array or `{ subscriptions: [...] }`. */
  async listSubscriptions(token?: string, signal?: AbortSignal): Promise<Subscription[]> {
    const res = await this.transport.request<Subscription[] | { subscriptions: Subscription[] }>({
      method: 'GET',
      path: '/api/subscriptions',
      token,
      signal,
    });
    return Array.isArray(res) ? res : res.subscriptions;
  }

  /** `GET /api/subscriptions/:id`. */
  getSubscription(id: string, signal?: AbortSignal): Promise<Subscription> {
    return this.transport.request({ method: 'GET', path: `/api/subscriptions/${idSegment(id, 'subscription id')}`, signal });
  }

  /** `POST /api/subscriptions/:id/stop`: the merchant stops; the runner shreds the packages. */
  stopSubscription(id: string, token: string, signal?: AbortSignal): Promise<Subscription> {
    return this.transport.request({
      method: 'POST',
      path: `/api/subscriptions/${idSegment(id, 'subscription id')}/stop`,
      token,
      signal,
    });
  }

  /** `GET /api/decode/:txid`: the public shape of any transaction, from the runner's node. */
  decode(txid: string, signal?: AbortSignal): Promise<Shape> {
    const t = txid.trim().toLowerCase();
    if (!TXID.test(t)) return Promise.reject(new ApiError(400, 'a txid is 64 hex characters'));
    return this.transport.request({ method: 'GET', path: `/api/decode/${t}`, signal });
  }

  /** `GET /api/status`: the runner's view of the chain. */
  status(signal?: AbortSignal): Promise<RunnerStatus> {
    return this.transport.request({ method: 'GET', path: '/api/status', signal });
  }

  // -------------------------------------------------- access passes (runners that list `pass`)

  /** `POST /api/subscriptions/:id/pass`: an access pass, asked for with the payer auth key's signature over the body `{}`. */
  async getPass(id: string, auth: PayerAuth, signal?: AbortSignal): Promise<PassResponse> {
    const path = `/api/subscriptions/${idSegment(id, 'subscription id')}/pass`;
    const body = {};
    // The transports send JSON.stringify(body), so these are the bytes signed.
    const headers = await auth.sign('POST', path, JSON.stringify(body));
    return this.transport.request({ method: 'POST', path, body, headers, signal });
  }

  /** `GET /api/passes/key`: the public key the runner signs passes with. */
  passKey(signal?: AbortSignal): Promise<PassKey> {
    return this.transport.request({ method: 'GET', path: '/api/passes/key', signal });
  }

  /** `POST /api/passes/verify`: the runner's own check of a pass. */
  verifyPass(pass: string, signal?: AbortSignal): Promise<PassVerifyResponse> {
    return this.transport.request({ method: 'POST', path: '/api/passes/verify', body: { pass }, signal });
  }

  // -------------------------------------------------- sandbox extension (testnet only)

  /** `POST /api/sandbox/offer`: an offer whose merchant is the sandbox wallet (testnet only). */
  sandboxOffer(body: SandboxOfferRequest, signal?: AbortSignal): Promise<CreateOfferResponse> {
    return this.transport.request({ method: 'POST', path: '/api/sandbox/offer', body, signal });
  }

  /** `POST /api/sandbox/fund`: the testnet auto-funder pays a pocket. */
  sandboxFund(body: SandboxFundRequest, signal?: AbortSignal): Promise<SandboxFundResponse> {
    return this.transport.request({ method: 'POST', path: '/api/sandbox/fund', body, signal });
  }

  /** `POST /api/sandbox/cheat`: ask the runner to attempt a forbidden action. */
  sandboxCheat(body: SandboxCheatRequest, signal?: AbortSignal): Promise<SandboxCheatResponse> {
    return this.transport.request({ method: 'POST', path: '/api/sandbox/cheat', body, signal });
  }
}

/** Whether a runner's status lists a v2 feature. An older runner lists none. */
export function hasFeature(status: Pick<RunnerStatus, 'features'> | null | undefined, feature: RunnerFeature): boolean {
  return Array.isArray(status?.features) && status.features.includes(feature);
}

/**
 * A weekly plan's later installments carry thousands of rungs each, so its upload runs
 * to several megabytes. Allow 30 s plus 30 s per megabyte (a slow 0.3 Mbit/s uplink),
 * at most 10 minutes.
 */
export function uploadTimeoutMs(installments: { sealed: string }[]): number {
  const mb = installments.reduce((n, i) => n + i.sealed.length, 0) / 1e6;
  return Math.min(600_000, Math.round(30_000 + 30_000 * mb));
}
