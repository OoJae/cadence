# Cadence

**Subscribe once. Close the tab.** Pre-authorized shielded payments on Zcash's Ironwood pool.

**Live on Zcash testnet:** [judge sandbox](https://app-production-be97.up.railway.app/sandbox) · [decoder](https://app-production-be97.up.railway.app/decode) · [cancel with a saved key](https://app-production-be97.up.railway.app/manage). This is the independent app host, which shows its commit and bundle hash in the footer. The same app is also served by the runner at [sandbox-production-1e16.up.railway.app](https://sandbox-production-1e16.up.railway.app/sandbox).

**The 60-second judge path.** Starting takes a minute; the run then finishes on its own in several minutes of testnet blocks.

1. Open the [sandbox](https://app-production-be97.up.railway.app/sandbox) and press **Create mandate and auto-fund**. The faucet pays a fresh pocket, and once that payment is mined your browser signs and seals all three installments and uploads them.
2. Save the cancel key (or skip it), then press **Close the payer tab**. From here only the runner acts: installments fall due 90 s apart.
3. While they land, press **Try it** on the four cheat cards: open a package early, raise an amount, rebroadcast a paid installment, stretch the plan. The runner really attempts each one and shows the error of the layer that stops it: drand, the payer's signature, the node, or the runner's schedule check.
4. Decode a mined installment from the timeline, or one from the last public run: [`70646526…`](https://app-production-be97.up.railway.app/decode/706465269dd006492028d65987d9972b0bc9303d47cfbc72b5cb87a6d527d3e4).
5. Optional: before the last installment lands, open **Manage** with your saved cancel key and cancel. Once the cancel is mined you get a cancellation certificate: the note it spent, that note's nullifier on chain, and the installments that can now never be valid.

**Why it doesn't leak:**

- Each installment is an ordinary 2-action v6 Ironwood send, with the standard fee, the default expiry, an anchor 3 blocks back and nothing recoverable from its outgoing ciphertexts. That was the most common shielded shape in a 200-block mainnet sample.
- The runner holds a view key for one single-use pocket, never for your wallet, and refunds leave no outgoing record, so it cannot see where they went.
- Until its drand round, each installment is a padded, time-locked blob, even to the runner.
- The web app makes no third-party requests and writes no browser storage (`pnpm verify` fails the build otherwise), and the CLI reaches the runner and the chain over Tor (except a runner on the same machine).

| Piece | Real or mocked |
|---|---|
| Pocket keys, rung signing, sealing (the sandbox's browser signer is `cadence-core` in WebAssembly) | Real |
| Runner: drand release, anchor, proving, broadcast, checks | Real, on Zcash testnet |
| Transactions | Real testnet transactions; decode any of them |
| Cheat buttons | Real: the runner tries each one |
| Faucet | Testnet only, and custodial: the sandbox's own wallet funds your pocket, and is also the merchant, so payments flow back to it |
| Network path | The plain web build is clearnet: Railway and the runner see your IP. Tor Browser or the CLI avoid that. |
| Who serves the app | Both: the independent [app host](https://app-production-be97.up.railway.app), with its build identity in the footer, and the runner on its own origin (see [Honest limits](#honest-limits)). |
| `pnpm dev` and the default web build | A mock runner and signer, labelled as such on every page |

---

Shielded Zcash can only *push*: a payment happens only while the payer's wallet is online and signs it. That rules out subscriptions, salaries, allowances and standing orders, unless you hand your funds to a custodian or keep a hot wallet running. Cadence gives shielded Zcash **pull payments without custody**:

1. **Fund once.** You fund a single-use *pocket* with one ZIP 321 QR from any Ironwood wallet (Zodl, Zkool, Vizor).
2. **Pre-sign and close the tab.** Cadence pre-signs every installment and seals each one: to a [drand](https://drand.love) round with tlock, so it cannot be opened before it is due, and to the merchant's runner with age.
3. **The runner releases each installment when it falls due.** It installs a fresh anchor, proves, and broadcasts. The runner software **can never spend, redirect or enlarge** a payment: it holds no spending key, and every byte it broadcasts was signed by you. (Whoever serves the web app serves the code that holds the pocket key; see [Honest limits](#honest-limits).)
4. **Cancel at any time** by spending your own pocket note. Every later installment becomes a double-spend that no node will accept, and the payer gets a certificate saying so. Whatever the runner never releases stays yours: `cadence sweep` returns it straight from the chain, with no runner involved.

The payee needs only a Zcash address. A runner (the merchant's own, or a hosted one) releases each payment, and it arrives in the payee's wallet with a memo such as "Cadence · Pro plan · payment 2 of 4". That suits stipends, donations and salaries as well as subscriptions.

| | Card or bank mandate | Pull payments on Ethereum or Bitcoin Cash | Zcash today (CipherPay, BLINK) | Cadence |
|---|---|---|---|---|
| Payer online every period | No | No | Yes: an invoice or request each period | No |
| Cancelling | A request to the merchant: Apple warns ["charges might still occur"](https://support.apple.com/en-us/118261) | A transaction that revokes the permission | Stop paying | A self-spend; consensus then refuses every later installment |
| What the merchant or executor can change | The charge, then the payer disputes it | Bounded by the contract or permission | Nothing | Nothing: the payer's signature covers amount and recipient |
| What the public sees | Nothing; the bank and the processor see everything | Payer, payee, amount and schedule | Each payment as a shielded send | An ordinary 2-action shielded send |

Every installment is an ordinary v6 Ironwood transaction: 2 actions, the ZIP 317 fee, the default expiry, an anchor three blocks back, and nothing recoverable from its outgoing ciphertexts. In a 200-block mainnet sample, taken before NU7, that was **the single most common shielded transaction shape** (see [Evidence](#evidence)).

---

## What the merchant's runner learns, and why it is scoped

The runner must hold **one pocket's Orchard-only full viewing key**. ZIP 374 defers the anchor and witness to proving time, and the prover needs the note's full viewing key to prove ([ZIP 374, "Prover"](https://zips.z.cash/zip-0374)). The alternative, proving everything up front, would force every installment to carry a stale, linkable anchor that a chain observer could pick out. Cadence instead keeps the key's reach as small as possible:

| The runner learns | The runner never learns |
|---|---|
| This pocket's prepaid balance, schedule and installments, which a subscription merchant knows anyway | Your main wallet: the pocket is a fresh seed at a non-zero ZIP 32 account, not derived from your wallet |
| That you cancelled, and when | Where cancelled funds went: every pocket output uses `OvkPolicy::Discard`, so even the pocket's own keys decrypt no outgoing record |
| | Your other subscriptions: each one has its own pocket |
| | Anything at all before each drand round, because the packages are time-locked |
| | Your IP, when you use the CLI (Tor via arti) or Tor Browser. The plain web build is disclosed as clearnet. |

The runner software **cannot**:

- change an amount or recipient (the signature covers both);
- release early (the drand signature does not exist yet);
- spend the pocket any other way (it has no spending key);
- rebroadcast a paid installment, or replay one after a cancel (its note is already spent).

It also **checks every schedule it accepts**: the offer's count, a pocket funded for all of it, and installments that follow the offer's period, so a payer cannot stretch a plan. And it **checks every package before it broadcasts**: an installment goes out only if it pays the merchant exactly the offer's amount, with the default expiry for its height. When a subscription ends, the runner deletes the pocket's account, viewing key, funding transaction and sealed packages, with SQLite `secure_delete` on.

## Status (Oct 26, 2026)

| Milestone | Result |
|---|---|
| S1: rung determinism, including across the NU7 boundary | ✅ `crates/cadence-core/tests/s1_determinism.rs` |
| S2: 3 chained installments, signed before their parents existed, released by a view-only runner on NU7 testnet | ✅ [`evidence/S2-testnet.md`](evidence/S2-testnet.md) |
| Full service on testnet: offer → subscribe → fund → drand release → mined, cancel, and a run over Tor | ✅ [`evidence/E2E-service-testnet.md`](evidence/E2E-service-testnet.md) |
| Public sandbox on Railway, signed in the browser with the WASM signer, cheats tried against the live runner | ✅ [`evidence/railway-sandbox.md`](evidence/railway-sandbox.md) |
| Upload check that refuses a stretched schedule; webhooks with Cadence and CipherPay signatures | ✅ in the code, with unit tests (`cargo test -p cadence-runner`) |
| Web app on an app host the merchant does not control, with its build identity in the footer | Live at https://app-production-be97.up.railway.app (`VITE_API=runners`, `deploy/railway-app/`) |
| Mainnet run funded from Zodl | ⏳ |

## Evidence

- **S2 (testnet):** three installments, `7ae2c96a…`, `c0daf3c1…` and `edad440b…`. Each one is:
  - v6 on NU7 with `lock_time = 0`;
  - 0 transparent, 0 Sapling and 0 Orchard-pool parts;
  - 2 Ironwood actions with flags 7;
  - a 10,000-zat fee and a 7,264-byte proof;
  - unreadable from its outgoing ciphertexts: 0 outputs open with the zero OVK, and 0 with the pocket's own OVKs.
- **The service, testnet:** [`evidence/E2E-service-testnet.md`](evidence/E2E-service-testnet.md). A subscription runs to completion with the real runner and the CLI; a cancel stops it, and the cancel transaction decodes with 0 outputs recoverable under the pocket's own keys; in a third run the runner's sync, drand fetch and broadcasts all go over Tor.
- **The public sandbox, testnet:** [`evidence/railway-sandbox.md`](evidence/railway-sandbox.md). Three installments signed in a clean browser and released by the Railway runner; open-early and tamper attempts refused by the live runner. A first run showed a timing tell (installments mined 5 and 11 blocks after their targets); the runner now releases in the tick that opens each package, and the re-run, driven from the independent app host, landed 1 to 3 blocks after target with all four cheats refused.
- **Fingerprint, mainnet sample:** 200 blocks (3,526,581–3,526,780) in [`evidence/fingerprint-mainnet-sample.json`](evidence/fingerprint-mainnet-sample.json).
  - The class "v6, Ironwood-only, 2 actions" is the most common shielded shape: 168 of 521 Orchard-family transactions.
  - Fee, flags, lock time, proof size and branch are identical across 100% of that class.
  - 78% are consistent with an anchor at target − 3, which is Cadence's rule.
- **Decode any transaction yourself:** `cadence-decode decode <txid>`, or the decoder page in the web app.

## Architecture

```
crates/cadence-core    pocket keys, rung ladders (DeferredPcztBuilder), mandate schedule, redaction  [native + wasm32]
crates/cadence-seal    age (runner) inside tlock (drand quicknet), zstd, fixed-size buckets            [native + wasm32]
crates/cadence-chain   lightwalletd over Tor (arti), compact-block cache, pocket wallet, prove + broadcast
crates/cadence-runner  merchant service: drand scheduler, release, confirmations, HTTP API, webhooks
crates/cadence-cli     payer: subscribe / resume / cancel / sweep (runner and chain over Tor), dev pocket tools
crates/cadence-decode  public-shape decoder and mainnet fingerprint scanner
crates/cadence-wasm    browser signer (Web Worker pool)
web/                   payer flow, merchant dashboard, decoder, judge sandbox (strict CSP, zero third-party requests)
```

### How a rung ladder works

v6 sighashes exclude anchors but commit to expiry and branch. So each installment is signed once for every candidate broadcast height in its window, and each of these is a *rung*. One keyed seed drives every random choice, so **all rungs of an installment contain byte-identical actions** and produce the same change note. The runner broadcasts only the rung for exactly the next block. If none exists, it fails closed: it waits, or marks the installment missed once the chain is past the window, and you cancel or sweep and subscribe again (there is no in-place re-sign yet). It never broadcasts a non-default expiry. Windows on mainnet skip the blocks just before NU7 (height 3,543,405). From the ZIP 2009 fee switch (3,590,000) rungs pay the new 2,000-zat fee, and no installment's window straddles the switch, so its rungs still agree.

## Run it

```sh
cargo build --release

# Merchant
cadence-runner init --network test
CADENCE_MERCHANT_TOKEN=… cadence-runner serve --network test

# Payer (runner calls and chain access go over Tor unless the runner is local)
# --first-in (default 60 s) must stay within one period plus 600 s, or the runner refuses the upload.
cadence subscribe --runner http://127.0.0.1:8737 --offer off_… --out my-sub.json
cadence cancel --subscription my-sub.json --to <your UA>
cadence sweep  --pocket my-sub.json --to <your UA>    # recover leftovers, no runner needed
```

## Credits and prior art

Cadence builds on the following, and does not claim to have invented the primitive:

- [ZIP 374](https://zips.z.cash/zip-0374) (PCZT, pre-authorization with deferred anchors) and [ZIP 229](https://zips.z.cash/zip-0229) (v6 transactions).
- [ZIP 318](https://zips.z.cash/zip-0318) and librustzcash's `zcash_pool_migration`, which pre-sign height-scheduled transfers for the payer's own wallet.
- `DeferredPcztBuilder` in zcash_primitives 0.31.
- [tlock](https://eprint.iacr.org/2023/189), using drand quicknet and `tlock_age`, and [age](https://age-encryption.org).

The closest prior art is on transparent chains, and on Zcash:

- **Pre-signed payment chains on Bitcoin Cash.** A [March 2026 design](https://bitcoincashresearch.org/t/recurring-payments-on-bitcoin-cash-two-working-approaches-no-covenants-no-op-return/1774) pre-signs a chain of `nLockTime`-dated transactions, each spending the previous one's change. The receiver broadcasts each when due, and the payer cancels by spending the change. Cadence uses the same shape. On BCH every amount and address is public. [Mecenas](https://cashscript.org/docs/language/examples) covenants let a recipient pull a fixed pledge each period, also in public view.
- **Ethereum.** Subscriptions (ERC-1337), streams (Superfluid), allowances (Safe) and periodic permissions (ERC-7715) all run on a public ledger.
- **Zcash today.** Subscriptions are push: [CipherPay](https://cipherpay.app/en/docs/subscriptions) issues an invoice each period that the customer must pay, and [BLINK](https://github.com/itzebe/blink-zcash) sends a fresh request because it "cannot move funds on the payer's behalf". [Zandglass](https://github.com/0xBadSign/zandglass), another ZECATHON entry, schedules payments as separate vaults, each sealed with drand to the payee and its due time.

Cadence's contribution is that pattern on the shielded pool, with a **third-party executor that holds no spending key**. Shielded transactions have no transparent inputs, so `nLockTime` cannot date them. Cadence therefore builds:

- "not before" from drand;
- "not after" from the v6 expiry;
- cancellation by self-spend;
- per-height rung ladders that match ordinary sends on every measured field.

The runner only ever broadcasts transactions the payer already signed.

## Honest limits

- **"Not before" rests on drand's threshold assumption.** `tlock_age` 0.0.10 is unaudited. Because age is the inner layer, a tlock failure only lets *the runner* open early; it can never redirect funds.
- **Unscheduled network upgrades invalidate rungs.** Each signature commits to the consensus branch, so a schedule that runs past an upgrade unknown at signing time must be signed again (cancel, then subscribe again; there is no in-place re-sign yet). Known boundaries are handled: windows skip the last blocks before NU7, and fees follow ZIP 2009 from height 3,590,000, which leaves the 8,000 zats each later installment saves in the pocket for `cadence sweep`.
- **The pocket is a software key.** Hardware wallets can fund it but cannot sign ladders.
- **Timing is public.** Short demo cadences are visible as a schedule. Monthly ones are a few ordinary transactions among thousands a day, but Cadence adds no jitter yet.
- **Whoever serves the web app serves the code that holds your pocket key.** On the live demo the runner serves it, so a dishonest merchant could serve code that steals the key; the runner software cannot. A `VITE_API=runners` build served from an origin the merchant does not control, with its commit and bundle sha256 in the footer to check against a build of your own, removes that risk, and so does the CLI. The build mode is supported (`web/README.md`, `deploy/railway-app/`) but no such host is deployed yet.
- **The hosting edge sees your IP.** The live demo runs on Railway, which sees the address of every browser that loads it, unless you use Tor Browser.
- **Webhooks are best-effort.** Three attempts from memory and no outbox; merchants reconcile from the API (`docs/merchant.md`).

Testnet software. Not audited.

## License

MIT OR Apache-2.0
