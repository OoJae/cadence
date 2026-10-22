# Cadence web

The browser front-end for Cadence: pre-authorized shielded standing orders on Zcash Ironwood.
You subscribe from Zodl with one QR code and close the tab. The merchant's runner releases each
pre-signed installment when it falls due. It cannot spend, redirect or enlarge them, and you cancel
by spending your own note.

| Route | What it is |
|---|---|
| `/` | The pull-vs-push gap on one screen, how it works, what the runner can and cannot do, honest limits, and what the merchant learns. |
| `/merchant` | Subscriptions and installments (sealed, due, broadcast, mined, cancelled, missed). Each has a live countdown to its drand round, and each txid links to the decoder. Also a "create offer" form whose share link carries the offer in the URL fragment. |
| `/subscribe#offer=…` | The payer flow: plan, ZIP 321 funding QR, signing progress, "You can close this tab now", then manage or cancel. |
| `/decode/:txid` | The public shape of a transaction as a table, with a stock-wallet comparison column and red/green badges for what a chain observer can and cannot tell. |
| `/sandbox` | The guided judge run: create a mandate, auto-fund, sign, close the tab, watch three installments land, decode, cancel. It also has three cheat buttons. |

![Landing](screenshots/01-landing.png)

## Run it

```sh
pnpm install
pnpm dev        # http://localhost:5173, mock runner, relaxed dev CSP (hot reload needs inline code)
pnpm build      # type-check, then a production build into dist/ with the strict CSP
pnpm preview    # serve dist/ at http://localhost:4173
pnpm test       # vitest unit tests
pnpm verify     # after a build: Playwright privacy check plus screenshots (see below)
```

Node 20 or newer works; this was built with Node 26 and pnpm 11. There are no runtime dependencies
beyond React and `uqr`, the QR encoder, which is bundled. The fonts (Inter, JetBrains Mono and
Instrument Serif, all OFL) are bundled from npm, Latin subset only.

Serve `dist/` as a single-page app: every path that is not a file falls back to `index.html`.
Routes use the History API, never the hash, because the hash carries offer data.

## Mock or real runner: `VITE_API`

`VITE_API` is read at build time. It decides which transport the typed client uses and which
origin goes into the CSP `connect-src`.

| `VITE_API` | Transport | `connect-src` |
|---|---|---|
| `mock` (default) | An in-memory runner and chain inside the page. It makes no network requests at all. | `'self'` |
| `self` | `fetch` to the same origin (the runner serves this app). | `'self'` |
| `https://runner.example` | `fetch` to that origin. | `'self' https://runner.example` |
| `http://xyz….onion` | `fetch` to a Tor onion service (open the app in Tor Browser). | `'self' http://xyz….onion` |

The build refuses any other `http://` origin. Example:

```sh
VITE_API=https://runner.example pnpm build
```

**The API client** (`src/api/client.ts`) is typed and covers every endpoint in `docs/api.md`:
`POST /api/offers`, `GET /api/offers/:id`, `POST /api/subscriptions`, `GET /api/subscriptions`,
`GET /api/subscriptions/:id`, `POST /api/subscriptions/:id/stop`, `GET /api/decode/:txid` and
`GET /api/status`. Two notes:

- The contract does not pin down the list shape of `GET /api/subscriptions`, so the client
  accepts either a bare array or `{ "subscriptions": [...] }`.
- The webhook body and event types are in `src/api/types.ts` for merchant integrations. The browser
  never receives webhooks.

**The mock** (`src/mock/`) follows the same rules as `crates/cadence-runner`:

- An installment opens when its drand round passes.
- It waits until its input note is 3 blocks deep (anchor = target − 3).
- It is broadcast only if a rung was signed for exactly tip + 1; otherwise it is *missed*.
- It becomes *cancelled* if its input was spent elsewhere first.

From page load on, the mock chain runs at 5-second blocks so the sandbox fits in a couple of
minutes. Real NU7 blocks are 25 seconds, and the UI says so wherever it matters.

**Sandbox endpoints** are a proposed, testnet-only extension that is not in `docs/api.md` v0:
`POST /api/sandbox/fund` (the auto-funder) and `POST /api/sandbox/cheat`. Only the mock implements
them. A production runner must not implement them, and against a real runner the sandbox page says
so.

### What is real and what is mocked

| Piece | Status |
|---|---|
| The three S2 installments (txids, heights, decoded shapes) | **Real.** Copied verbatim from `evidence/s2-testnet-decoded.json`. A test fails if the copy drifts. |
| The S2 row on the merchant dashboard | Real txids and heights. Its amounts and release rounds are illustrative, and the row is labelled. |
| The other dashboard rows, and decodes of their txids | Synthetic, labelled "mock". Their shapes follow the S2 rules. |
| The "stock wallet send" column | A reference profile built by the same rules a stock `zcash_client_backend` send follows. It is **not** a decoded Zodl transaction. Use `?compare=<txid>` to fill it from a real decode. |
| The signer | Mock (see below). The real one is the WASM build of `cadence-core`. |
| Cheat-button errors | Reproduced by the mock runner (see below). |

**Cheat errors.** The lines that start with `installment k:` use the exact message formats from
`crates/cadence-runner` (its `println!` and `bail!` strings). That includes "its input was spent
elsewhere; mandate cancelled" and the "mined at …" shape line. The drand, `age` and node lines
reproduce what those components do:

- **Open early.** There is no beacon yet for the round, and `age` answers `No matching keys found`.
- **Tamper.** The sighash changes, so the spend authorization no longer verifies.
- **Replay.** A duplicate nullifier makes it a double-spend.

The tlock packaging and the replay probe are not in the runner yet. Once a real runner implements
`/api/sandbox/cheat`, the sandbox shows its output verbatim.

## The `Signer` interface

`src/signer/types.ts` defines it. The WASM signer, being built separately, plugs in by
implementing it:

```ts
export interface Signer {
  readonly implementation: 'mock' | 'wasm';
  /** 'memory' forgets the pocket key when the tab closes; 'passkey' keeps it sealed (WebAuthn PRF / passphrase). */
  readonly keyCustody: 'memory' | 'passkey';

  /** Fresh single-use pocket: new random seed, non-zero ZIP 32 account, Orchard-only UA and UFVK. */
  createPocket(network: 'main' | 'test'): Promise<PocketInfo>;          // { network, ua, ufvk, birthday_height }

  /** Resolves when a payment of at least expectedZat reaches the pocket (the mempool is enough). */
  awaitFunding(expectedZat: number, opts?: { signal?: AbortSignal }): Promise<FundingTx>;  // { txid, value_zat, status, mined_height? }

  /** Sign every installment for every candidate height, then redact, compress, seal (age) and time-lock (tlock). */
  presign(offer: Offer, fundingTx: FundingTx, opts?: PresignOptions): Promise<SealedInstallment[]>;  // [{ k, release_round, sealed }]

  /** Spend the pocket's current note to the payer's own UA with OvkPolicy::Discard. */
  cancel(refundUa: string): Promise<CancelReceipt>;                    // { txid, refunded_zat, fee_zat, target_height }

  /** Zeroise all key material. */
  destroy(): void;
}
```

`PresignOptions` takes `onProgress(p)`, which drives the "Signing your schedule…" view: the
installment, its phase (`sign`, `redact`, `compress`, `seal`, `timelock`, `done`), rungs signed so
far and the candidate height window. It also takes an `AbortSignal`, and a `signedAt` time from
which the schedule is planned (`src/lib/schedule.ts`).

`awaitFunding` and `destroy` extend the three methods in the brief. Funding has to be detected
before signing can start, and keys need an explicit end of life.

**The mock signer** (`src/signer/mock.ts`):

- It keeps a random 32-byte seed in a private class field, and nothing else.
- It derives UA- and UFVK-shaped strings from the seed with SHA-256. They have no valid Bech32m
  checksum, so no real wallet can pay them, and the QR is marked "mock pocket · do not pay".
- Every sealed package is the same fixed size (16 KiB of random bytes).
- `destroy()` zeroises the seed.

**To wire in the WASM signer**, return it from `createSigner()` in `src/runtime.ts`. The CSP already
allows `'wasm-unsafe-eval'` (WebAssembly compilation only, not JavaScript eval) and
`worker-src 'self'`.

## Privacy guarantees of the front-end

Each item below is enforced in code or checked by `pnpm verify`. That script serves the production
build, drives every page and both flows in headless Chromium, and fails on any of the following:

- a request to any other origin;
- a CSP violation;
- a console error;
- any write to `localStorage`, `sessionStorage` or cookies.

1. **No third-party requests, ever.** There are no analytics, trackers, crash reporters, CDNs or web
   fonts from elsewhere. Code, styles and fonts are served from this origin, and the QR is drawn as
   inline SVG by a bundled encoder. In mock mode the page fetches only its own static files and
   makes no API requests at all.
2. **A strict Content-Security-Policy**, injected into `index.html` at build time
   (`src/config/csp.ts`):

   ```
   default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self';
   font-src 'self'; connect-src 'self' [VITE_API origin]; worker-src 'self'; manifest-src 'self';
   media-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none';
   require-trusted-types-for 'script'; trusted-types 'none'
   ```

   The policy allows no inline script, no inline style element and no eval. Trusted Types are
   enforced and no policy may be created, so no code path can write HTML strings into the DOM. A
   unit test asserts the policy's shape.
3. **Offer data only in the URL fragment.** Share links are `/subscribe#offer=<base64url(json)>`.
   Browsers never send the fragment to a server, so neither the web host nor the runner learns who
   opened a link. The fragment is untrusted input and is parsed strictly (`src/lib/offer.ts`):
   - fields are checked by type and range;
   - unknown fields are dropped;
   - size is capped;
   - only https or .onion runners are accepted, on drand quicknet only;
   - names containing control, zero-width or bidi-override characters are refused, because they
     could spoof the display.

   Before signing, the app also checks the offer against the runner's own copy
   (`GET /api/offers/:id`), and that the named runner is the one this build may talk to.
4. **No secrets in browser storage.** The app writes nothing to `localStorage`, `sessionStorage`,
   IndexedDB or cookies. Even the theme choice is kept in memory. The merchant's bearer token lives
   in memory for the life of the tab. The mock signer's seed lives in a private field and is
   zeroised on `destroy()`.
5. **Requests leak as little as possible.** Every `fetch` uses `credentials: 'omit'`,
   `referrerPolicy: 'no-referrer'`, `cache: 'no-store'` and `redirect: 'error'`, so a runner cannot
   bounce the browser to a third party. The page also sets `<meta name="referrer" content="no-referrer">`.
   Background tabs stop polling.
6. **Honest copy.** The app never claims to be "trustless" or "untraceable". It says exactly what
   is hidden from whom, and lists its limits:
   - release times rest on drand;
   - the runner must be online;
   - the runner holds the pocket's full viewing key;
   - upgrades need a re-sign;
   - timing is public;
   - this page shows your IP address to the runner unless you use Tor Browser.

What the front-end cannot guarantee on its own:

- **Your IP address.** The web host sees page loads. The runner sees your IP when you subscribe,
  unless you use Tor Browser or the Tor-only CLI.
- **Response headers.** A `<meta>` CSP cannot set `frame-ancestors`. Deploy with these headers:

```
Content-Security-Policy: <the policy above>; frame-ancestors 'none'
Referrer-Policy: no-referrer
X-Content-Type-Options: nosniff
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Resource-Policy: same-origin
Permissions-Policy: camera=(), microphone=(), geolocation=(), browsing-topics=()
```

## Tests

`pnpm test` runs 55 vitest tests:

- `src/lib/offer.test.ts`: fragment parsing. Round trip, hostile and damaged links, display-spoofing
  names, wrong networks, non-https runners.
- `src/lib/zip321.test.ts`: ZIP 321 URIs. Exact decimal amounts, unpadded base64url memos,
  percent-encoding, the 512-byte memo limit, and no memo to transparent addresses.
- `src/lib/states.test.ts`: state labels, plus runner log lines that match the real runner's
  formats.
- `src/lib/drand.test.ts`: quicknet round ↔ time, and the schedule.
- `src/mock/runner.test.ts`: installment state derivation (chaining, cancel, missed, stop) and the
  three cheats.
- `src/signer/mock.test.ts`: the `Signer` contract (single-use pockets, fixed-size packages, cancel
  rules, `destroy`).
- `src/data/s2.test.ts`: the S2 copy matches the evidence file, and every invariant holds.
- `src/config/csp.test.ts`: the `VITE_API` parsing and the CSP's shape.

## Screenshots

`pnpm verify` regenerates `screenshots/`:

- the landing page in dark and light;
- the merchant dashboard;
- the decoder;
- every payer step;
- the sandbox: close the tab, three installments landed, an inline decode, then cancelled with all
  three cheats rejected;
- mobile views.

## Layout

```
src/api/        typed client, wire types, fetch transport
src/mock/       in-memory chain + runner + fixtures (dynamically imported, mock builds only)
src/signer/     Signer interface, MockSigner
src/lib/        offer fragment, ZIP 321, drand, amounts, states, shape checks, runner log formats
src/components/ UI pieces: tables, QR, timeline, flow views, disclosure panel
src/pages/      Landing, Merchant, Subscribe, Decode, Sandbox
src/config/     VITE_API parsing and the CSP (shared with vite.config.ts)
scripts/        verify-and-screenshot.mjs
```
