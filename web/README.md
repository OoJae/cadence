# Cadence web

The browser front-end for Cadence: pre-authorized shielded standing orders on Zcash Ironwood.
You subscribe from Zodl with one QR code and close the tab. The merchant's runner releases each
pre-signed installment when it falls due. The runner software cannot spend, redirect or enlarge
them, and you cancel by spending your own note. Whoever serves this app serves the code that holds
the pocket key: see "Build identity" and `docs/threat-model.md`, §6.

| Route | What it is |
|---|---|
| `/` | The story as you scroll, over a stage drawn from testnet run 1's real rung ladders: the pull-vs-push gap, signing a rung for every block, sealing to a drand round, the one release, the four refusals, cancelling, the on-chain shape, then what the runner can and cannot do, honest limits and what the merchant learns. |
| `/merchant` | Subscriptions and installments (sealed, due, broadcast, mined, cancelled, missed). Each has a live countdown to its drand round, and each txid links to the decoder. Also a "create offer" form whose share link carries the offer in the URL fragment. On a runner that lists them, the form also takes a free trial and a fiat price with the merchant's own rate, from which it computes the ZEC amount. Stop needs a merchant token, so it is disabled on the sandbox until one is entered. |
| `/subscribe#offer=…` | The payer flow: plan (with any trial, and the merchant's price label next to the ZEC amount signed), ZIP 321 funding QR, signing progress, "save your cancel key, then check it opens" (WASM signer: re-pick the file, retype the passphrase), "You can close this tab now", then manage or cancel. The done screen also offers calendar reminders and, on a runner that lists `pass`, "Get an access pass". |
| `/manage` | Cancel after the tab is gone: load the saved cancel key and its passphrase, see the pocket and subscription, cancel and refund to your own address. On a runner that lists `refund_after_stop`, a stopped or missed plan offers "Refund what's left" instead. Also calendar reminders, an access pass, "Subscribe again" once the plan has ended, and the note that pausing means cancelling now and subscribing again later. Shows the `cadence sweep` fallback when the runner cannot help. |
| `/pass` | Checks an access pass: decodes it, finds the runner that signed it among the runners this build knows, verifies the Ed25519 signature in the tab against that runner's pass key, and asks the runner's own verify endpoint too. It shows a merchant how to make the same check on their own server. |
| `/decode/:txid` | The public shape of a transaction as a table, with a stock-wallet comparison column and red/green badges for what a chain observer can and cannot tell. Its checks follow the runner's network, the transaction's branch and its height (see below). |
| `/status#sub=<subscription_id>` | A demo view of one subscription: status, k of n paid, the next installment due, and per installment its state, release time and drand round, txid and mined height, with a short shape summary of each mined one and a note where a plan crosses NU7. It polls `GET /api/subscriptions/:id` and `GET /api/status` every 30 s and decodes mined installments with `GET /api/decode/:txid`, keeping results in memory only. The id is in the fragment, so it is not part of the page request, but the page does send it to the runner. It also offers calendar reminders, and "Subscribe again" once the plan has ended. |
| `/sandbox` | The guided judge run: create a mandate, auto-fund, sign, close the tab, watch three installments land, decode, cancel. It also has four cheat cards: open early, tamper, rebroadcast a paid installment, and stretch the plan. On a runner that lists `charge_after_cancel` there is a fifth, "Charge me after I cancel", which waits for the first voided installment's drand round after a cancel and then has the runner try it. |
| `/brand` | The brand book, which is also the design system: the mark, the wordmark, colour, type, motion, components, textures, downloads and the social card, each the real component or token. |

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

Use Node 22.12 or newer (vitest needs it; a build alone works on 20.19), and run `pnpm exec playwright install chromium` once before the `verify` scripts. This was built with Node 26, pnpm 11 and Rust 1.96.0; `pnpm build:wasm` also needs the `wasm32-unknown-unknown` target, wasm-bindgen-cli 0.2.129 and Homebrew LLVM (`scripts/build-wasm.sh` says why). The runtime dependencies are React,
`uqr` (the QR encoder), `lenis` (eased wheel scrolling on the landing and /brand) and `three` (core
only, for the landing's WebGL stage, in a lazy chunk), all bundled. The fonts (Inter, JetBrains Mono
and Bodoni Moda, all OFL) are bundled from npm, Latin subset only.

Serve `dist/` as a single-page app: every path that is not a file falls back to `index.html`.
Routes use the History API, never the hash, because the hash carries offer data.

## Mock or real runner: `VITE_API`

`VITE_API` is read at build time. It decides which transport the typed client uses and which
origin goes into the CSP `connect-src`.

| `VITE_API` | Transport | `connect-src` |
|---|---|---|
| `mock` (default) | An in-memory runner and chain inside the page. It requests nothing but its own static files. | `'self'` |
| `self` | `fetch` to the same origin (the runner serves this app). | `'self'` |
| `https://runner.example` | `fetch` to that origin. | `'self' https://runner.example` |
| `http://xyz….onion` | `fetch` to a Tor onion service (open the app in Tor Browser). | `'self' http://xyz….onion` |
| `runners` | An app host of its own: `fetch` to each origin in `VITE_RUNNERS`, and to no other. | `'self'` plus each of them |

The build refuses any other `http://` origin (localhost excepted, for development), and any host
with a wildcard. Example:

```sh
VITE_API=https://runner.example pnpm build
```

**`VITE_API=runners`** serves the app from an origin no runner controls, so the merchant does not
serve the code that holds the payer's pocket key (`deploy/README.md`, "App host"):

- `VITE_RUNNERS` is a comma-separated list of exact origins: https, or http only for .onion and
  localhost; no path, credentials, query, fragment or wildcard.
- `VITE_DEFAULT_RUNNER` (default: the first) serves the pages with no runner of their own:
  `/sandbox`, `/merchant`, `/decode`, `/status` and the header's runner pill, which polls its
  `GET /api/status` every 5 s on every page.
- `/subscribe` talks to the runner the offer's `runner_endpoint` names, and `/manage` to the one the
  cancel key names, matched by origin, and only if it is in the list. Otherwise the page refuses and
  points to `<runner>/subscribe` or `<runner>/manage`. The cancel key records the offer's runner.
- The runners need `--app-url` (or `--cors-origin`) for this origin, or the browser blocks their
  answers (`docs/api.md`, "CORS").
- Setting `VITE_RUNNERS` or `VITE_DEFAULT_RUNNER` in any other mode is a build error, so a build
  never quietly ignores the list.

```sh
VITE_SIGNER=wasm VITE_API=runners \
  VITE_RUNNERS="https://sandbox.example,https://main.example" \
  VITE_DEFAULT_RUNNER="https://sandbox.example" pnpm build
```

**The API client** (`src/api/client.ts`) is typed and covers the endpoints in `docs/api.md` that
the app uses: offers, pockets (register, state, witness), `POST /api/broadcast`, subscriptions
(create, list, get, stop), access passes (get one, signed with the payer auth key; the pass key;
verify), `GET /api/decode/:txid`, `GET /api/status` and the three sandbox endpoints. It has no
call for re-signing, which only the CLI does. Notes:

- **Features.** The app sends or shows a contract v2 thing only when the runner's
  `GET /api/status` lists it in `features` (`src/lib/features.ts`). A runner with no `features`,
  such as the mainnet runner's build 7244e6a, gets exactly the requests an older app sent.
- **A 429 is busy, not broken.** The transport turns it into an `ApiError` that carries the
  `Retry-After` seconds, and shows "The runner is busy; try again in n s". Polls wait at least that
  long before asking again, and an upload or a cancel is sent again after the wait.
- The contract does not pin down the list shape of `GET /api/subscriptions`, so the client
  accepts either a bare array or `{ "subscriptions": [...] }`.
- Webhooks are documented in `docs/api.md` ("Webhooks"), not in `src/api/types.ts`, whose
  `WebhookEvent` is a partial, unused type. The browser never receives webhooks.

**The mock** (`src/mock/`) follows the same rules as `crates/cadence-runner`:

- An installment opens when its drand round passes.
- It waits until its input note is 3 blocks deep (anchor = target − 3).
- It is broadcast only if a rung was signed for exactly tip + 1; otherwise it is *missed*.
- It becomes *cancelled* if its input was spent elsewhere first.

From page load on, the mock chain runs at 5-second blocks so the sandbox fits in a couple of
minutes. Real NU7 blocks are 25 seconds, and the UI says so wherever it matters. The mock lists
the features `trial`, `quote`, `payer_auth`, `pass`, `charge_after_cancel` and `fund_offer`, and
implements them, with a pass key from a fixed seed, so mock builds show them.

**Sandbox endpoints** (`POST /api/sandbox/offer`, `/fund` and `/cheat`, in `docs/api.md`,
"Testnet sandbox") are testnet-only. The real runner serves them only on testnet with
`--sandbox-funder`; the mock implements them too. Against a runner without them, the sandbox page
says so.

### What is real and what is mocked

| Piece | Status |
|---|---|
| The three S2 installments (txids, heights, decoded shapes) | **Real.** Copied verbatim from `evidence/s2-testnet-decoded.json`. A test fails if the copy drifts. |
| The S2 row on the merchant dashboard | Real txids and heights. Its amounts and release rounds are illustrative, and the row is labelled. |
| The other dashboard rows, and decodes of their txids | Synthetic, labelled "mock". Their shapes follow the S2 rules. |
| The "stock wallet send" column | A reference profile built by the same rules a stock `zcash_client_backend` send follows. It is **not** a decoded Zodl transaction. Use `?compare=<txid>` to fill it from a real decode. |
| The signer | Mock by default (see below). `VITE_SIGNER=wasm` ships the real one: `cadence-core` compiled to WebAssembly (see "The WASM signer"). |
| Cheat-button output | From a real sandbox runner, its own log lines, verbatim. In mock mode, reproduced by the mock runner (see below). |
| The sandbox's runner log | Written by this page from the runner's API answers (`src/lib/runnerLog.ts`), in the style of the runner's log; not the runner's own output. |

**Cheat errors in mock mode.** The mock runner returns the real runner's verdict shape (`kind`,
`k`, `outcome`, `stage`, `log`) and reproduces what each component does:

- **Open early.** There is no beacon yet for the round, and `age` answers `No matching keys found`.
- **Tamper.** The sighash changes, so the spend authorization no longer verifies.
- **Rebroadcast.** It resends the latest mined installment; a duplicate nullifier makes it a
  double-spend. `replay_after_cancel` is accepted as the old name.
- **Stretch.** It moves installment 2 and every later one a year later and runs the mock's
  schedule check, which its upload uses too: rounds must increase, and each installment must follow
  the one before by the offer's period, to within one drand round (3 s). The real runner's check is
  looser and broader (`docs/api.md`, `POST /api/subscriptions`).
- **Charge after cancel.** Once the cancel is mined and the first voided installment's round has
  passed, it answers as the sandbox runner does: the node refuses the broadcast as a double-spend
  of the note the cancel spent. Before that round, `409` with "installment k opens in n s".

The mock's log lines are its own wording, close to but not the same as the real runner's.

### The decoder's checks

`src/lib/shape.ts` holds the chain rules, from `zcash_protocol` 0.11, `zcash_primitives` 0.31 and
`cadence-core`. The decoder reads the runner's network from one `GET /api/status`, and its checks and
table wait for it.

- The implied target height is the expiry height less the default delta of the transaction's
  branch: 40 blocks before NU7 (NU6.3) and 120 from NU7. An unknown branch fails the check rather
  than being guessed.
- The expected fee is the installment fee at that target on that network: 10,000 zats, or 2,000 on
  mainnet from height 3,590,000. The fee row is labelled "ZIP 317 fee" or "ZIP 2009 fee".
- The stock-send column is built at the decoded transaction's own target height on the runner's
  network.
- An unmined transaction is not failed on the anchor check; a mined one with no anchor range is.
- The S2 example txids fall back to their decodes in `evidence/` when the runner cannot find them,
  as on a mainnet runner.

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
  /** Check a saved cancel key, picked again: it opens with the passphrase and is this pocket's key. */
  verifyKit(bytes: Uint8Array, passphrase: string): Promise<KitCheck>;

  /** Spend the pocket's current note to the payer's own UA with OvkPolicy::Discard. */
  cancel(refundUa: string, opts?: CancelOptions): Promise<CancelReceipt>;  // { txid, refunded_zat, fee_zat, target_height }

  /** The payer auth key, derived from the seed: its public key, and request signatures. Never the seed. */
  payerAuth(): Promise<PayerAuth>;                                        // { publicKeyHex, sign(method, path, body) }

  /** Zeroise all key material. */
  destroy(): void;
}
```

`PresignOptions` takes `onProgress(p)`, which drives the "Signing your schedule…" view: the
installment, its phase (`sign`, `redact`, `compress`, `seal`, `timelock`, `done`), rungs signed so
far and the candidate height window. It also takes an `AbortSignal`, and a `signedAt` time from
which the schedule is planned (`src/lib/schedule.ts`): installment k at
`signedAt + trial + min(period, 60 s) + (k − 1)·period + jitter_k`.

**Release jitter.** The WASM signer draws each `jitter_k` from the browser's CSPRNG, uniformly in
[0, J] with J = ⌊min(period / 4, 6 h)⌋, by the same rejection rule as `cadence-core`'s
`draw_jitter`; `src/lib/schedule.test.ts` and the Rust tests check the same vectors
(`crates/cadence-core/tests/schedule_vectors.json`). It hides the exact interval, not the rhythm.
Before signing, the plan step shows each installment's window, from no jitter to J. The 45-day
limit (`src/lib/offer.ts::horizonProblem`) is measured to the latest the last installment can
fall: trial + lead + (count − 1)·period + J. The mock signer draws no jitter, so a mock build
plays the same schedule every run.

**The payer auth key** (`src/lib/payerAuth.ts`) is an Ed25519 key whose seed is
HKDF-SHA256(pocket seed, salt `cadence payer auth v1`, no info), made with WebCrypto: HKDF, then
the seed imported as PKCS#8 into a non-extractable key and zeroed. The flow sends its public key
as `payer_auth_key` only to a runner that lists `payer_auth`, and signs the access-pass request
with it (`docs/api.md`, "Payer auth, access passes and re-signing"). A pocket restored from a
cancel key derives the same key, so the kit needed no new field.

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
| `presign` | For each installment: its release time with its own jitter, then `round_for(release_at)` and `mandate::window`. The window is cut into chunks across the pool, and every chunk must agree on the spent nullifier, the actions digest and the change note. The ladder is then sealed (zstd, age to the runner, tlock to the round). The flow uploads it with `POST /api/subscriptions`, adding `pocket_id`. |
| `sealKit` | A worker writes the seed, the schedule (mandate id, label, terms, first release, funding transaction and height) and every pocket note into the kit JSON and encrypts it with age's scrypt recipient (`cadence_seal::seal_kit`, work factor 17, a few seconds). The page gets the ciphertext only and downloads it as `cadence-cancel-key-YYYYMMDD-HHMM.age`, the local date and time, with no pocket id: file names travel through download folders, backups and recent-file lists. |
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
encrypted to a passphrase. A new key needs at least 12 characters, or 4 different words, and
the page refuses very common passwords and patterns such as keyboard and digit runs, repeats, and
those with digits around them (`src/signer/kit.ts::passphraseProblem`). A key saved earlier
with a shorter passphrase still opens; `cadence-seal` itself still seals with any of 8 characters
or more. The page then has the payer pick the file again
and retype the passphrase. `verifyKit` opens it in a worker (`openKit`'s path), derives the address
from the opened seed, and `checkKit` (`src/signer/kit.ts`) passes it only if the network, pocket id
and address match this tab's pocket; the opened seed is zeroed either way. Wrong file, wrong
passphrase, another pocket's key and a damaged file each get their own message. Only a verified key
makes the tab closeable, and nothing on the page calls the key saved until it is verified. The
payer may instead go without a key, or skip the check; on `/subscribe` each sits behind a
confirmation saying that without the key you cannot cancel, or get back what is left after a
merchant stop, a missed installment or overfunding (`cadence sweep` needs the key too). The sandbox
skips with one click. Anyone with the file and the passphrase can cancel and take the remaining
balance; the app never sends either anywhere. `/manage` loads it into this
tab's memory (forgotten on reload), and the CLI reads the same file:
`cadence cancel --subscription <key> --to <UA>`, or `cadence sweep --pocket <key> --to <UA>`, which
needs no runner. The commands the page prints single-quote a file name the shell would split or
expand, such as `'cadence-cancel-key-20261028-0905 (1).age'`. The download is a Blob URL and
`<a download>`, which the CSP does not restrict. Calendar reminders (`src/lib/ics.ts`) are saved
the same way: an `.ics` file with one event per payment still to come, each with an alarm an hour
before, holding the plan's name, the amount and "payment k of n" and no subscription id, pocket,
address or URL, with a random UID per event.
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
   inline SVG by a bundled encoder. API requests go to the runner (in a `runners` build, to the
   runners it lists, which the footer names). In mock mode the page fetches only its own static
   files and makes no API requests at all.
2. **A strict Content-Security-Policy**, injected into `index.html` at build time
   (`src/config/csp.ts`):

   ```
   default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self';
   font-src 'self'; connect-src 'self' [VITE_API origin or VITE_RUNNERS]; worker-src 'self'; manifest-src 'self';
   media-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none';
   require-trusted-types-for 'script'; trusted-types 'none'
   ```

   The policy allows no inline script, no inline style element and no eval. Trusted Types are
   enforced and no policy may be created, so no code path can write HTML strings into the DOM. A
   unit test asserts the policy's shape. `VITE_SIGNER=wasm` builds make exactly one change. They
   use `trusted-types cadence-worker` instead of `'none'`, for one policy that can only produce
   same-origin worker script URLs (see "The WASM signer").
3. **Offer data only in the URL fragment.** Share links are `/subscribe#offer=<base64url(json)>`.
   Browsers never send the fragment to a server, so the offer's contents reach neither the web
   host nor the runner. When the page opens, though, it asks the runner the offer names for its
   copy by id (`GET /api/offers/<id>`), so that runner and its hosting edge learn that this IP
   opened that offer. The fragment is untrusted input and is parsed strictly (`src/lib/offer.ts`):
   - fields are checked by type and range;
   - unknown fields are dropped;
   - size is capped;
   - only https or .onion runners are accepted, on drand quicknet only;
   - names containing control, zero-width or bidi-override characters are refused, because they
     could spoof the display.

   Before signing, the app also checks that the named runner is one this build may talk to, and the
   offer against that runner's own copy (`GET /api/offers/:id`).
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
   - this page shows your IP address to the runner unless you use Tor Browser;
   - whoever serves this page serves the code that holds the pocket key.

What the front-end cannot guarantee on its own:

- **The code it runs.** Whoever serves this app decides what it does, including with the pocket
  key. When the merchant's runner serves it (`VITE_API=self`, as on the live demo), that is the
  merchant. A `runners` build on an app host the merchant does not control, checked against a build
  of your own ("Build identity"), or the CLI, avoids that.
- **Your IP address.** The web host, and the hosting edge in front of it (Railway for the demo),
  see page loads. The runner sees your IP when you subscribe, unless you use Tor Browser or the
  Tor-only CLI. In a `runners` build, the default runner also sees the header pill's
  `GET /api/status` every 5 s on every page, and only the offer's or the key's runner sees
  subscribe or cancel traffic.
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

Every build writes that header CSP, with `frame-ancestors 'none'`, to `dist/csp.txt`. A static host
should send it as the `Content-Security-Policy` header on every response, worker scripts included;
`deploy/railway-app/Caddyfile` does. In a `runners` build, `connect-src` holds `'self'` and every
listed runner.

## Build identity

Every build writes `dist/build.json` (`src/config/buildInfo.ts`):

| Field | Meaning |
|---|---|
| `commit` | Short hash of the checked-out commit, or `null` outside a git checkout. |
| `dirty` | Whether the checkout had tracked or untracked, non-ignored changes. |
| `api`, `runners`, `signer` | The build mode, its runner origins, and the signer. |
| `files` | The SHA-256 of every emitted file, by path relative to `dist/`. |
| `bundle_sha256` | The SHA-256 of a manifest of `<sha256>  <path>\n` lines, one per file except `build.json`, sorted by path in byte order: what `shasum -a 256` prints. |

The footer reads `build.json` from its own origin and shows "Built from commit X; bundle sha256 Y".
The commit is not in the bundle, so the same sources give the same `bundle_sha256` at any commit.

To check that a host serves the files of a build you made or trust:

```sh
# 1. The hash of your own build (equals its bundle_sha256):
cd web/dist && find . -type f ! -path ./build.json | sed 's|^\./||' | LC_ALL=C sort \
  | xargs shasum -a 256 | shasum -a 256
# 2. The files the host says it serves:
curl -s https://APP/build.json | jq -r '.files | to_entries[] | "\(.value)  \(.key)"' > served.sha256
# 3. Hash what it actually serves; no output means every listed file matches:
while read -r sum path; do printf '%s  %s\n' "$(curl -s "https://APP/$path" | shasum -a 256 | cut -d' ' -f1)" "$path"; done \
  < served.sha256 | diff - served.sha256
# 4. Compare served.sha256 with your dist's files, or bundle_sha256 with step 1.
# 5. The header CSP should equal the build's:
curl -sI https://APP/ | grep -i content-security-policy; curl -s https://APP/csp.txt
```

The served `build.json` is only the host's claim; the check is against a hash you computed or got
from elsewhere.

### Rebuilding `bundle_sha256` from a commit

With the tools in the table below, a commit builds the same bytes wherever it is checked out,
WebAssembly included. `scripts/build-wasm.sh` maps the checkout, `CARGO_HOME`, the Rust toolchain and the target directory
to fixed paths (`--remap-path-prefix`), so no path of the building machine is left in the modules. The
workspace also patches `i18n-embed-fl` (`crates/patches/`), whose `fl!()` emitted age's error
arguments in a different order on every compile.

What was checked: on one Mac (arm64), with no `wasm-opt`, the branch was built in its checkout and in
a fresh clone at another path, with its own `CARGO_HOME` and target directory. All four files in
`src/wasm/` had the same SHA-256, and a third build from a new target directory matched them. A mock
build and a `VITE_SIGNER=wasm VITE_API=runners` build each gave the same `bundle_sha256` in both
checkouts. Nothing has been compared across machines or operating systems yet.

To rebuild a served build, at the commit its footer names (if `build.json` says `dirty: true`, the
build had uncommitted changes and the commit alone does not give it):

```sh
git clone https://github.com/OoJae/cadence && cd cadence && git checkout <commit>
cargo install --locked wasm-bindgen-cli --version 0.2.129
cd web && pnpm install --frozen-lockfile
pnpm build:wasm                   # rustup installs the pinned toolchain; keep wasm-opt off PATH
VITE_SIGNER=wasm VITE_API=runners \
  VITE_RUNNERS="<build.json's runners, comma-separated, in order>" \
  VITE_DEFAULT_RUNNER="<the default runner>" pnpm build
node -p 'require("./dist/build.json").bundle_sha256'
```

What has to match the build you compare with:

| What | Used for the check above | Why |
|---|---|---|
| Rust | 1.96.0, from `rust-toolchain.toml` | rustc generates the modules' code |
| wasm-bindgen-cli | 0.2.129, the crate's `=0.2.129` | it writes the `.js` glue and rewrites the `.wasm` |
| clang for wasm32 | Homebrew clang 23.1.4 | `secp256k1-sys`'s C is compiled into both modules |
| wasm-opt | not installed | the script runs it whenever it is on `PATH`, and it changes the bytes |
| Node, pnpm | Node 26.0.0, pnpm 11.1.2 | they run the build; the lockfile pins every package |
| Build settings | `VITE_SIGNER`, `VITE_API`, `VITE_RUNNERS`, `VITE_DEFAULT_RUNNER` | they are compiled in. `build.json` records the first three, but not the default runner. |

A build made before the path mapping has this machine's paths in its modules, so no one else can
rebuild it byte for byte. The bundle the app host serves as of Oct 28 is one of these. CI builds
the WebAssembly with Ubuntu's clang, not the clang in the table, so its module hashes are not
expected to match a Mac build's; it prints them, but they have not been compared.

## Tests

`pnpm test` runs the vitest tests:

- `src/lib/offer.test.ts`: fragment parsing. Round trip, hostile and damaged links, display-spoofing
  names, wrong networks, non-https runners; trials and quotes in the link; the 45-day horizon,
  counting the trial and the most jitter.
- `src/lib/schedule.test.ts`: release jitter. J is a quarter period, at most 6 hours; draws are
  uniform, with rejection at the top of the 32-bit range; the release times match the vectors the
  Rust payer checks (`crates/cadence-core/tests/schedule_vectors.json`); every jittered schedule,
  from a 60 s period to 30 days, with and without a trial, passes the runner's schedule check.
- `src/lib/terms.test.ts`: trials and quotes. `amount_zat` from a price and a rate, exactly and
  half up; money formatting; the merchant form's bounds; the 1% mismatch warning.
- `src/lib/payerAuth.test.ts`: the payer auth key against a vector `node:crypto` computes on its
  own; the signed message, which fails to verify with any part changed; no path with an origin or
  a query; distinct timestamps for two requests in one second.
- `src/lib/pass.test.ts`: reading a pass, `valid_until` (including during a trial), finding the
  runner that signed it, a pass through the mock runner end to end, and the merchant example on
  `/pass`.
- `src/lib/refund.test.ts`: when /manage offers "Refund what's left" (the feature listed and a
  note left), the CLI sweep kept for an old runner, and a refund after a stop against a fake v2
  runner.
- `src/lib/ics.test.ts`: calendar reminders. One event per installment at its release time in UTC,
  an alarm an hour before, CRLF and line folding, escaping, and no ids, addresses or URLs.
- `src/lib/again.test.ts`, `src/lib/features.test.ts`: "Subscribe again" once a plan has ended,
  and reading `features` (none for an older runner).
- `src/api/http.test.ts`: a 429 reads as busy, with `Retry-After` as seconds or a date, and polls
  wait at least as long.
- `src/flow.test.ts`: uploads retried after a timeout, a 5xx or a 429 but not a refusal; the payer
  auth key sent only to a runner that lists `payer_auth`, and byte for byte the old request
  otherwise; a plan past the horizon refused before any pocket exists; signing or watching again
  after a failure.
- `src/pages/Sandbox.test.ts`: the faucet-low notice, and the charge-after-cancel card's target and
  countdown.
- `src/lib/zip321.test.ts`: ZIP 321 URIs. Exact decimal amounts, unpadded base64url memos,
  percent-encoding, the 512-byte memo limit, and no memo to transparent addresses.
- `src/lib/states.test.ts`: state labels, plus runner log lines that match the real runner's
  formats.
- `src/lib/drand.test.ts`: quicknet round ↔ time, and the schedule.
- `src/mock/runner.test.ts`: installment state derivation (chaining, cancel, missed, stop), the
  four cheats and the old `replay_after_cancel` name, and the mock's schedule check; its v2
  features: charge after cancel, trials and quotes, funding an offer's exact prepay, and access
  passes (issued, refused with 403 or 409, verified).
- `src/signer/mock.test.ts`: the `Signer` contract (single-use pockets, fixed-size packages, cancel
  rules, `destroy`), and the cancel key: save, `verifyKit`, restore into a fresh signer, cancel; the
  stronger passphrase for a new key; the payer auth key, the same after a restore and different for
  each pocket.
- `src/signer/kitCheck.test.ts`: `checkKit` with fakes and, when `src/wasm/` is present, with the
  real cadence-wasm build in Node through the worker's own handlers.
- `src/lib/shape.test.ts`: the decoder's checks on mainnet before NU7, after NU7 on both sides of
  3,590,000, and on testnet; null fields, an unknown branch, the moved reference column.
- `src/lib/planStatus.test.ts`: the `/status` page's logic, including the NU7 crossing note.
- `src/pages/Merchant.test.ts`: the receiving address against the runner's network; Stop needing a
  token on a sandbox runner; an offer with no trial or quote sent exactly as before.
- `src/config/runners.test.ts`, `src/runtime.test.ts`: `VITE_RUNNERS` parsing and picking the
  runner an offer or a cancel key names.
- `src/config/buildInfo.test.ts`: the build manifest and its hash, as `shasum` computes them.
- `src/signer/kit.test.ts`: the cancel key's JSON against the CLI's `SubscriptionFile`, read from
  `crates/cadence-cli/src/subscribe.rs`; parsing and refusals; the runner and network checks; the
  file name with no id; shell-quoted CLI commands; the new-key passphrase rules.
- `src/signer/cancel.test.ts`: the cancel loop with fake timers: waiting for anchor depth, giving
  up, abort, losing the race to an installment (retry once, or nothing left), other refusals, and
  waiting out a busy runner without proving twice.
- `src/data/s2.test.ts`: the S2 copy matches the evidence file, and every invariant holds.
- `src/config/csp.test.ts`: the `VITE_API` and `VITE_SIGNER` parsing and the CSP's shape, including
  the one Trusted Types policy of WASM-signer builds, `runners` builds, and the header CSP against
  the runner's `WEB_CSP` and both Caddyfiles.
- `src/signer/wasmEngine.test.ts`: the WASM signer's pipeline with a fake pool. It covers change
  chaining, pipelining, progress order, disagreeing shards, foreign notes, exhausted pockets and
  abort. It also tests the worker pool with fake workers: priorities, lazy start, trapped workers,
  abort and terminate.

`pnpm verify:app-host` (`scripts/app-host-smoke.mjs`) builds a `runners` app against two local
stub runners, serves it with the app host's headers and drives headless Chromium; its header
comment lists the checks.

**CI.** `.github/workflows/ci.yml` runs on pushes and pull requests to `main`:
`cargo test --workspace` on the pinned toolchain; `pnpm typecheck`, `pnpm test`, the mock build
and `pnpm verify` on Node 22; and the WebAssembly signer built from source with Ubuntu's clang,
then `pnpm verify:wasm`. It needs no secrets and talks to no runner, lightwalletd or drand. Its
first run, on Oct 28 at e232541, passed all three jobs, as has each push since. `pnpm verify`
against each production build before it is deployed stays a manual step.

`cargo test -p cadence-wasm` covers the Rust side:

- sharded output equals unsharded output;
- every rung matches what `cadence_core::mandate::presign` signs;
- note encoding round trips;
- sealed packages open with a real beacon;
- the cancel builds and signs.

`cargo test -p cadence-wasm --release --features prover -- --include-ignored` adds two more tests:

- the whole sharded pipeline against `mandate::presign` over full windows;
- a cancel proved and extracted natively.

## Design

The look is "the pulled rung": the landing's stage is testnet run 1's three rung ladders at their real
counts, and at each drand round exactly one rung, the one for the next block, is pulled out in amber
and the rest can never be used. Amber marks only what happens next. `/brand` documents the system;
the tokens live at the top of `src/styles/app.css` (`src/motion/tokens.ts` mirrors the motion ones, and
a test keeps the two in step).

The stage is built twice from one timeline (`src/stage/timeline.ts`). The SVG tier always ships and is
what phones, reduced motion and headless browsers see. On desktops with a capable GPU, a WebGL tier
(`src/stage/GlStage.ts`, three.js core) loads once the page is idle and fades in over it; it renders on
demand, steps down or hands back to the SVG if frames run long, and disposes its context when you
leave. Only transform and opacity animate; with reduced motion every reveal and the release show their
end state. Page changes run as view transitions where the browser has them.

## Screenshots

`pnpm verify` regenerates `screenshots/`:

- the landing page in dark and light, and its release moment (`07-landing-release`);
- the brand book (`08-brand`);
- the merchant dashboard;
- the decoder;
- every payer step;
- the sandbox: close the tab, three installments landed, an inline decode, then cancelled with the
  first three cheats rejected;
- mobile views, and every route at 375 px (`33-375-*`).

It also checks that no route scrolls sideways at 375 px and that, with reduced motion, nothing
animates. `VERIFY_HEADED=1` runs it in a visible browser, so the WebGL stage loads.
`pnpm verify:judge` walks the judge path on the deployed app host and the live sandbox runner; it
spends testnet TAZ from the faucet, so run it once per deploy.

## Layout

```
src/api/        typed client, wire types, fetch transport
src/mock/       in-memory chain + runner + fixtures (dynamically imported, mock builds only)
src/signer/     Signer interface, MockSigner, WasmSigner (wasm.ts) with its worker pool, workers and engine
src/wasm/       wasm-bindgen output of pnpm build:wasm (gitignored)
src/lib/        offer fragment, ZIP 321, drand, schedule and jitter, amounts, states, shape checks, runner log formats,
                trial and quote terms, payer auth, access passes, refunds, calendar reminders
src/components/ UI pieces: tables, QR, timeline, flow views, disclosure panel
src/pages/      Landing (and landing/), Merchant, Subscribe, Manage, Status, Decode, Sandbox, Pass, Brand
src/stage/      the landing's stage: the shared timeline and geometry, the SVG driver, the WebGL tier
src/motion/     reveals, beats, smooth scrolling and the motion tokens
src/brand/      the round rail, the drawn ladders, the outlined wordmark, contrast maths
src/config/     VITE_API, VITE_RUNNERS and VITE_SIGNER parsing, the CSP and build identity (shared with vite.config.ts)
scripts/        verify-and-screenshot.mjs, build-wasm.sh, wasm-smoke.mjs + wasm-smoke/ (harness page), app-host-smoke.mjs,
                judge-path.mjs, brand/ (wordmark outliner, social card and icon export)
```
