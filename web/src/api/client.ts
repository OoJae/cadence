import type {
  BroadcastRequest,
  BroadcastResponse,
  CreateOfferRequest,
  CreateOfferResponse,
  CreateSubscriptionRequest,
  CreateSubscriptionResponse,
  Offer,
  PocketState,
  PocketWitness,
  RegisterPocketRequest,
  RegisterPocketResponse,
  RunnerStatus,
  SandboxCheatRequest,
  SandboxCheatResponse,
  SandboxFundRequest,
  SandboxFundResponse,
  Shape,
  Subscription,
} from './types';

export type Method = 'GET' | 'POST';

export interface ApiRequest {
  method: Method;
  /** Always starts with `/api/`. */
  path: string;
  body?: unknown;
  /** Merchant bearer token. Held by the caller in memory only. */
  token?: string;
  signal?: AbortSignal;
}

/** Something that can carry a request to a runner: `fetch`, or the in-memory mock. */
export interface Transport {
  readonly label: string;
  request<T>(req: ApiRequest): Promise<T>;
}

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
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
    return this.transport.request({ method: 'POST', path: '/api/subscriptions', body, signal });
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

  // -------------------------------------------------- sandbox extension (testnet only)

  /** `POST /api/sandbox/fund`: the testnet auto-funder pays a pocket. */
  sandboxFund(body: SandboxFundRequest, signal?: AbortSignal): Promise<SandboxFundResponse> {
    return this.transport.request({ method: 'POST', path: '/api/sandbox/fund', body, signal });
  }

  /** `POST /api/sandbox/cheat`: ask the runner to attempt a forbidden action. */
  sandboxCheat(body: SandboxCheatRequest, signal?: AbortSignal): Promise<SandboxCheatResponse> {
    return this.transport.request({ method: 'POST', path: '/api/sandbox/cheat', body, signal });
  }
}
