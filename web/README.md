# Cadence web

The browser front-end for Cadence: pre-authorized shielded standing orders on Zcash Ironwood.
You subscribe from Zodl with one QR code and close the tab. The merchant's runner releases each
pre-signed installment when it falls due. It cannot spend, redirect or enlarge them, and you cancel
by spending your own note.

| Route | What it is |
|---|---|
| `/` | The pull-vs-push gap on one screen, how it works, what the runner can and cannot do, honest limits, and what the merchant learns. |
| `/merchant` | Subscriptions and installments (sealed, due, broadcast, mined, cancelled, missed). Each has a live countdown to its drand round, and each txid links to the decoder. Also a "create offer" form whose share link carries the offer in the URL fragment. |
| `/subscribe#offer=…` | The payer flow: plan, ZIP 321 funding QR, signing progress, "save your cancel key" (WASM signer), "You can close this tab now", then manage or cancel. |
| `/manage` | Cancel after the tab is gone: load the saved cancel key and its passphrase, see the pocket and subscription, cancel and refund to your own address. Shows the `cadence sweep` fallback when the runner cannot help. |
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

pnpm build:wasm   # build the real signer (crates/cadence-wasm) into src/wasm/ (see "The WASM signer")
pnpm verify:wasm  # after build:wasm: the WASM signer end to end in headless Chromium
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
| The signer | Mock by default (see below). `VITE_SIGNER=wasm` ships the real one: `cadence-core` compiled to WebAssembly (see "The WASM signer"). |
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

`src/signer/types.ts` defines it. `MockSigner` (`src/signer/mock.ts`) and `WasmSigner`
(`src/signer/wasm.ts`) implement it:

```ts
export interface Signer {
  readonly implementation: 'mock' | 'wasm';
  /** 'memory' forgets the pocket key when the tab closes (save a cancel key to cancel later); 'passkey' is planned. */
  readonly keyCustody: 'memory' | 'passkey';

  /** Fresh single-use pocket: new random seed, non-zero ZIP 32 account, Orchard-only UA and UFVK. */
  createPocket(network: 'main' | 'test'): Promise<PocketInfo>;          // { network, ua, ufvk, birthday_height }

  /** Resolves when a payment of at least expectedZat reaches the pocket (WASM: once mined; the mock: the mempool). */
  awaitFunding(expectedZat: number, opts?: { signal?: AbortSignal }): Promise<FundingTx>;  // { txid, value_zat, status, mined_height? }

  /** Sign every installment for every candidate height, then redact, compress, seal (age) and time-lock (tlock). */
  presign(offer: Offer, fundingTx: FundingTx, opts?: PresignOptions): Promise<SealedInstallment[]>;  // [{ k, release_round, sealed }]

  /** The cancel key: seed, schedule and notes as the CLI's subscription file, encrypted to a passphrase in a worker. */
  sealKit(passphrase: string, ctx: KitContext): Promise<SealedKit>;   // { bytes, fileName }
  /** Decrypt a cancel key in a worker; restore it into a fresh signer. */
  openKit(bytes: Uint8Array, passphrase: string): Promise<OpenedKit>;
  restore(kit: OpenedKit): Promise<PocketInfo>;

  /** Spend the pocket's current note to the payer's own UA with OvkPolicy::Discard. */
  cancel(refundUa: string, opts?: CancelOptions): Promise<CancelReceipt>;  // { txid, refunded_zat, fee_zat, target_height }

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

## The WASM signer: `VITE_SIGNER`

`VITE_SIGNER` is read at build time. `mock` (the default) ships the mock signer. `wasm` ships
`WasmSigner`, which is `cadence-core` and `cadence-seal` compiled to WebAssembly
(`crates/cadence-wasm`) and run in Web Workers. The choice is a build-time constant, so a mock
build contains no trace of the WASM signer, its workers or its wasm. The WASM signer needs a real
runner, because it registers pockets with `POST /api/pockets`:

```sh
pnpm build:wasm                               # needs wasm32-unknown-unknown, wasm-bindgen-cli 0.2.129, Homebrew LLVM
VITE_SIGNER=wasm VITE_API=self pnpm build     # the build fails if src/wasm/ is missing
```

`scripts/build-wasm.sh` builds two modules into `src/wasm/`, which is gitignored. The Vite build
emits them as `dist/wasm/…`, and `pnpm dev` serves them at `/wasm/…`. Everything comes from this
origin and nothing comes from a CDN:

| Module | wasm (gzip -9) | What loads it |
|---|---|---|
| `wasm/signer/` | 2.47 MB (0.94 MB) | the signing pool: pocket, funding decryption, rungs, sealing, the cancel's signature |
| `wasm/prover/` | 5.21 MB (1.77 MB) | one prover worker, only while cancelling |

These sizes are without `wasm-opt`. The script runs it when binaryen is installed.

**What it does.**

| Step | How |
|---|---|
| `createPocket` | A worker draws 32 random bytes with `crypto.getRandomValues` and derives the Orchard-only UA and UFVK. The seed comes back as a `Uint8Array` and stays in a private field. The UFVK is registered with `POST /api/pockets`. |
| `awaitFunding` | Polls `GET /api/pockets/:id` every 5 s while the tab is visible. When `funding` appears, a worker decrypts the relayed `tx_hex` with the pocket key (`mandate::decrypt_funding`). The amount is never taken from the runner. |
| `presign` | For each installment: `round_for(release_at)` and `mandate::window`. The window is cut into chunks across the pool, and every chunk must agree on the spent nullifier, the actions digest and the change note. The ladder is then sealed (zstd, age to the runner, tlock to the round). The flow uploads it with `POST /api/subscriptions`, adding `pocket_id`. |
| `sealKit` | A worker writes the seed, the schedule (mandate id, label, terms, first release, funding transaction and height) and every pocket note into the kit JSON and encrypts it with age's scrypt recipient (`cadence_seal::seal_kit`, work factor 17, a few seconds). The page gets the ciphertext only and downloads it as `cadence-cancel-key-<pocket>.age`. |
| `openKit`, `restore` | A worker decrypts the kit and checks its shape (`src/signer/kit.ts`); the seed comes back as a `Uint8Array`. `restore` re-derives the pocket's UA from the seed and refuses a kit whose UA differs. |
| `cancel` | Starts a prover worker and its proving key at once (about 14 s). Finds the live pocket note among the runner's `notes`, by nullifier, among the notes this signer created. Fetches `GET …/witness`, signs the spend (note minus the fee at the cancel's height, to the refund UA's Orchard receiver, no OVK) in the pool, proves and extracts in the prover worker, then `POST /api/broadcast`. It checks that the runner's txid matches. `src/signer/cancel.ts` waits for a fresh note to be 3 blocks deep (retrying every 15 s, up to 5 minutes), and if an installment spends the note first it cancels that installment's change instead, once, or reports that nothing is left. |
| `destroy` | Zeroises the seed and terminates every worker, which drops their wasm memory. |

**The worker pool** (`src/signer/wasmPool.ts`, `wasmWorker.ts`, `wasmEngine.ts`):

- It has `min(8, hardwareConcurrency − 1)` module workers. They start lazily and each serves one
  request at a time.
- Workers are stateless. Every request carries the seed and the note it needs, so any worker can
  sign any chunk. All rungs of installment k use the same builder seed and input note, so the
  chunks produce byte-identical actions.
- The queue is ordered by priority: k's chunks, then k's sealing, then k+1's chunks.
- Installment k+1 starts as soon as the first chunk of k returns its change note, so the pool never
  idles between installments.
- A wasm trap retires that worker, and a fresh one replaces it. A worker that cannot start fails the
  whole pool, so it never respawns in a loop.

**Measured** (headless Chromium 1.60, 10-core Apple Silicon): a 2-installment schedule over real
windows (157 + 196 = 353 rungs) presigns and seals in **3.1 s** with 8 workers (8.9 ms per rung
effective). The same schedule takes 5.3 s with 4 workers and 19.7 s with 1 (55.8 ms per rung, as
in the spike). Each sealed package is 128 KiB. A cancel takes about 47 s end to end. Most of that
is building the proving key and proving single-threaded.

**CSP.** `new Worker(url)` is a Trusted Types sink. Under `trusted-types 'none'`, Chromium refuses
to start a worker at all. WASM-signer builds therefore allow exactly one policy,
`trusted-types cadence-worker`, which passes only same-origin http(s) script URLs. Mock builds keep
`'none'`. Everything else is unchanged. A dedicated worker takes its CSP from its own response
headers, not from the page, so deploy the header CSP with `'wasm-unsafe-eval'` (it is part of the
policy) on the worker scripts too.

**Key custody** is `'memory'`, as in the mock: closing the tab forgets the pocket key. After the
upload, the payer is asked to save a **cancel key** before "You can close this tab now": the kit,
encrypted to a passphrase of at least 8 characters. Anyone with the file and the passphrase can
cancel and take the remaining balance; the runner never sees either. `/manage` loads it into this
tab's memory (forgotten on reload), and the CLI reads the same file:
`cadence cancel --subscription <key> --to <UA>`, or `cadence sweep --pocket <key> --to <UA>`, which
needs no runner. The download is a Blob URL and `<a download>`, which the CSP does not restrict.
Passkey sealing is not built yet.

**`pnpm verify:wasm`** (`scripts/wasm-smoke.mjs`) builds a harness page (`scripts/wasm-smoke/`)
with this `vite.config.ts`. It serves the page with the production response headers, plays the
runner for the payer endpoints, and drives headless Chromium. It fails on any off-origin request,
CSP violation, console error or storage write. A native helper
(`crates/cadence-wasm/examples/smoke_fixture.rs`) mints a real, proven funding transaction to the
pocket (spending a stand-in faucet note in a one-leaf tree). The same helper opens the sealed
packages and parses the cancel. The run has two parts:

1. **Engine.** It signs 1 installment over 20 heights from a synthetic funding note and seals it to
   drand round 33,000,000, which has a public beacon. The helper opens the package with that beacon
   and verifies every rung's spend authorization signatures.
2. **Signer.** It runs `WasmSigner` end to end: register, decrypt the funding, presign 2 installments
   over their real windows, upload, cancel with the proof made in the browser, and broadcast. The
   helper then parses the cancel natively: 2 Ironwood actions, a 10,000-zat value balance, and a
   matching txid.

Options: `--no-cancel`, `--count N`, `--pool N`.

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
   unit test asserts the policy's shape. `VITE_SIGNER=wasm` builds make exactly one change. They
   use `trusted-types cadence-worker` instead of `'none'`, for one policy that can only produce
   same-origin worker script URLs (see "The WASM signer").
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

`pnpm test` runs the vitest tests:

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
  rules, `destroy`), and the cancel key: save, restore into a fresh signer, cancel.
- `src/signer/kit.test.ts`: the cancel key's JSON against the CLI's `SubscriptionFile`, read from
  `crates/cadence-cli/src/subscribe.rs`; parsing and refusals; the runner and network checks.
- `src/signer/cancel.test.ts`: the cancel loop with fake timers: waiting for anchor depth, giving
  up, abort, losing the race to an installment (retry once, or nothing left), other refusals.
- `src/data/s2.test.ts`: the S2 copy matches the evidence file, and every invariant holds.
- `src/config/csp.test.ts`: the `VITE_API` and `VITE_SIGNER` parsing and the CSP's shape, including
  the one Trusted Types policy of WASM-signer builds.
- `src/signer/wasmEngine.test.ts`: the WASM signer's pipeline with a fake pool. It covers change
  chaining, pipelining, progress order, disagreeing shards, foreign notes, exhausted pockets and
  abort. It also tests the worker pool with fake workers: priorities, lazy start, trapped workers,
  abort and terminate.

`cargo test -p cadence-wasm` covers the Rust side:

- sharded output equals unsharded output;
- every rung matches what `cadence_core::mandate::presign` signs;
- note encoding round trips;
- sealed packages open with a real beacon;
- the cancel builds and signs.

`cargo test -p cadence-wasm --release --features prover -- --include-ignored` adds two more tests:

- the whole sharded pipeline against `mandate::presign` over full windows;
- a cancel proved and extracted natively.

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
src/signer/     Signer interface, MockSigner, WasmSigner (wasm.ts) with its worker pool, workers and engine
src/wasm/       wasm-bindgen output of pnpm build:wasm (gitignored)
src/lib/        offer fragment, ZIP 321, drand, amounts, states, shape checks, runner log formats
src/components/ UI pieces: tables, QR, timeline, flow views, disclosure panel
src/pages/      Landing, Merchant, Subscribe, Decode, Sandbox
src/config/     VITE_API and VITE_SIGNER parsing and the CSP (shared with vite.config.ts)
scripts/        verify-and-screenshot.mjs, build-wasm.sh, wasm-smoke.mjs + wasm-smoke/ (harness page)
```
