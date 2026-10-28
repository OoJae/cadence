import { ApiError, type ApiRequest, type Transport } from './client';

const TIMEOUT_MS = 20_000;

/**
 * `fetch` transport. Requests carry no cookies, no referrer and no cache, and refuse
 * redirects (so a runner cannot bounce the browser to a third party). The CSP
 * connect-src allows only this origin anyway.
 */
export class HttpTransport implements Transport {
  readonly base: string;
  readonly label: string;

  constructor(base: string) {
    this.base = base;
    this.label = base === '' ? 'same-origin runner' : new URL(base).host;
  }

  async request<T>(req: ApiRequest): Promise<T> {
    const headers: Record<string, string> = { ...req.headers, Accept: 'application/json' };
    if (req.body !== undefined) headers['Content-Type'] = 'application/json';
    if (req.token) headers.Authorization = `Bearer ${req.token}`;

    const timeout = AbortSignal.timeout(req.timeoutMs ?? TIMEOUT_MS);
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;

    let res: Response;
    try {
      res = await fetch(this.base + req.path, {
        method: req.method,
        headers,
        body: req.body === undefined ? undefined : JSON.stringify(req.body),
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        cache: 'no-store',
        redirect: 'error',
        signal,
      });
    } catch (e) {
      if (signal.aborted && timeout.aborted) throw new ApiError(0, 'the runner did not answer in time');
      throw new ApiError(0, `could not reach the runner (${(e as Error).message})`);
    }

    const text = await res.text();
    let json: unknown = undefined;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        throw new ApiError(res.status, `the runner sent something that is not JSON (HTTP ${res.status})`);
      }
    }
    if (!res.ok) {
      const msg =
        json && typeof json === 'object' && 'error' in json && typeof (json as { error: unknown }).error === 'string'
          ? (json as { error: string }).error
          : `HTTP ${res.status}`;
      throw new ApiError(res.status, msg);
    }
    return json as T;
  }
}
