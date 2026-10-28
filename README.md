# Cadence

**Subscribe once. Close the tab.** Pre-authorized shielded payments on Zcash's Ironwood pool.

**Live on Zcash testnet:** [judge sandbox](https://app-production-be97.up.railway.app/sandbox) · [decoder](https://app-production-be97.up.railway.app/decode) · [cancel with a saved key](https://app-production-be97.up.railway.app/manage). This is a separate app host, which shows its commit and bundle hash in the footer. Each runner also serves an earlier build of the app (7244e6a, before the redesign), for example at [sandbox-production-1e16.up.railway.app](https://sandbox-production-1e16.up.railway.app/sandbox).

**Live on Zcash mainnet:** a weekly mandate, subscribed from Zodl on Oct 27 with the tab then closed, pays a separate wallet through judging. See its [status](https://main-production-d975.up.railway.app/status#sub=sub_747f99039ba4f43c5234) (also on the [app host](https://app-production-be97.up.railway.app/status#sub=sub_747f99039ba4f43c5234)) and the [evidence](evidence/mainnet.md). Its third payment (Nov 10), already signed on Oct 27, will be the first after NU7, which is expected around Nov 5. That crossing was rehearsed on a local regtest chain on Oct 28 ([evidence](evidence/nu7-regtest.md)); the mainnet crossing itself is still ahead. The status page shows times in your browser's time zone, and the app host's names it; the evidence gives them in UTC.

**The 60-second judge path.** Starting takes a minute; the run then finishes on its own in several minutes of testnet blocks.

1. Open the [sandbox](https://app-production-be97.up.railway.app/sandbox) and press **Create mandate and auto-fund**. The faucet pays a fresh pocket, and once that payment is mined your browser signs and seals all three installments and uploads them.
2. Save the cancel key (or skip it), then press **Close the payer tab**. From here only the runner acts: installments fall due about 90 s apart.
3. While they land, press **Try it** on the four cheat cards: open a package early, raise an amount, rebroadcast a paid installment, stretch the plan. The runner really attempts each one and shows the error of the layer that stops it: drand, the payer's signature, the node, or the runner's schedule check.
4. Decode a mined installment from the timeline, or one from the last public run: [`70646526…`](https://app-production-be97.up.railway.app/decode/706465269dd006492028d65987d9972b0bc9303d47cfbc72b5cb87a6d527d3e4).
5. Optional: to try a cancel, create the mandate with **4** installments every **300 seconds**, which leaves room between payments, and keep the tab in front. Right after an installment is mined, open **Manage** with your saved cancel key (or **Reopen and unlock to cancel** in the payer pane) and cancel, refunding to your own testnet address or with **Refund to the sandbox faucet (demo only)**. Once the cancel is mined you get a cancellation certificate: the note it spent, that note's nullifier on chain, and the installments that can now never be valid. With this build's release jitter, consecutive payments fall due anywhere from 225 to 375 s apart, rather than exactly 300, so the room for a cancel varies. A sandbox of this build also has a fifth cheat card, **Charge me after I cancel**: once the first voided installment's drand round passes, the runner opens the package it kept, proves it and broadcasts it, and the node refuses it, because the cancel spent its note.

**Why it doesn't leak:**

- Each installment is an ordinary 2-action v6 Ironwood send, with the standard fee, the default expiry, an anchor 3 blocks back and nothing recoverable from its outgoing ciphertexts. That was the most common shielded shape in a 200-block mainnet sample.
- The runner holds a view key for one single-use pocket, never for your wallet, and refunds leave no outgoing record, so it cannot see where they went.
- Until its drand round, each installment is a padded, time-locked blob, even to the runner.
- The web app makes no third-party requests and writes no browser storage (`pnpm verify`, which we run against every production build before deploying it, and which the CI workflow also runs on the mock build, fails on any off-origin request, CSP violation or storage write), and the CLI reaches the runner and the chain over Tor (except a runner on the same machine).

| Piece | Real or mocked |
|---|---|
| Pocket keys, rung signing, sealing (the sandbox's browser signer is `cadence-core` in WebAssembly) | Real |
| Runner: drand release, anchor, proving, broadcast, checks | Real, on Zcash testnet |
| Transactions | Real testnet transactions; decode any of them |
| Cheat buttons | Real: the runner tries each one |
| Faucet | Testnet only, and custodial: the sandbox's own wallet funds your pocket, and is also the merchant, so payments flow back to it |
| Network path | The plain web build is clearnet: Railway and the runner see your IP. Tor Browser or the CLI avoid that. |
| Who serves the app | Both: a separate [app host](https://app-production-be97.up.railway.app), with its build identity in the footer, and each runner on its own origin (see [Honest limits](#honest-limits)). |
| `pnpm dev` and the default web build | A mock runner and signer, labelled as such on every page |

---

Shielded Zcash can only *push*: a payment happens only while the payer's wallet is online and signs it. That rules out subscriptions, salaries, allowances and standing orders, unless you hand your funds to a custodian or keep a hot wallet running. Cadence gives shielded Zcash **pull payments without custody**:

1. **Fund once.** You fund a single-use *pocket* with one ZIP 321 QR from any Ironwood wallet (Zodl, Zkool, Vizor).
2. **Pre-sign and close the tab.** Cadence pre-signs every installment and seals each one: to a [drand](https://drand.love) round with tlock, so it cannot be opened before it is due, and to the merchant's runner with age.
3. **The runner releases each installment when it falls due.** It installs a fresh anchor, proves, and broadcasts. The runner software **can never spend, redirect or enlarge** a payment: it holds no spending key, and every byte it broadcasts was signed by you. (Whoever serves the web app serves the code that holds the pocket key; see [Honest limits](#honest-limits).)
4. **Cancel at any time** by spending your own pocket note. Every later installment becomes a double-spend that no node will accept, and the payer gets a certificate saying so. Whatever the runner never releases stays yours: `cadence sweep` returns it straight from the chain, with no runner involved, and after a merchant stop or a missed payment a runner of this build lets the browser refund it too.

The payee needs only a Zcash address. A runner (the merchant's own, or a hosted one) releases each payment, and it arrives in the payee's wallet with a memo such as "Cadence · Pro plan · payment 2 of 4". That suits stipends, donations and salaries as well as subscriptions.

Payments are converging on the same pattern: authorise once, within limits, and let payments happen later without you. Card and bank mandates do it, and so does Google's [Agent Payments Protocol (AP2)](https://github.com/google-agentic-commerce/AP2), whose signed mandates let an agent pay when the user isn't present. Cadence does it for shielded Zcash, with no custodian and without showing the public who pays whom.

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

It also **checks every schedule it accepts**: the offer's count, a pocket funded for all of it, and installments that follow the offer's period, so a payer cannot stretch a plan. And it **checks every package before it broadcasts**: an installment goes out only if it pays the merchant exactly the offer's amount, with the default expiry for its height. When a subscription completes or is cancelled, the runner deletes the pocket's account, viewing key, raw funding transaction and sealed packages, with SQLite `secure_delete` on. The funding txid and amount, and the installment txids, stay as the record of what was paid.

This build keeps two kinds of pocket for longer, on purpose:

- **After a merchant stop, or a missed or invalid installment.** The runner keeps the pocket's wallet account, so the payer can refund what is left from the browser (Manage → **Refund what's left**). A stop still deletes the packages, beacons, the stored viewing-key copy and the funding transaction at once. The account goes when the runner sees the refund, when nothing is left, or after 30 days. Until then the runner sees any spend of the pocket, and shows the refund's txid in the subscription's JSON, which anyone with the subscription id can read. With Discard it still cannot see where the refund went.
- **On the testnet sandbox, after a cancel.** The runner keeps the voided packages and the pocket's account for an hour, for the charge-after-cancel card.

The mainnet runner's build 7244e6a lists no `refund_after_stop`: it deletes the account at a stop, and the web app offers it no browser refund, so there `cadence sweep` recovers what is left.

## Status (Oct 28, 2026)

| Milestone | Result |
|---|---|
| S1: rung determinism, including across the NU7 boundary | ✅ `crates/cadence-core/tests/s1_determinism.rs` |
| S2: 3 chained installments, signed before their parents existed, released by a view-only runner on NU7 testnet | ✅ [`evidence/S2-testnet.md`](evidence/S2-testnet.md) |
| Full service on testnet: offer → subscribe → fund → drand release → mined, cancel, and a run over Tor | ✅ [`evidence/E2E-service-testnet.md`](evidence/E2E-service-testnet.md) |
| Public sandbox on Railway, signed in the browser with the WASM signer, cheats tried against the live runner | ✅ [`evidence/railway-sandbox.md`](evidence/railway-sandbox.md) |
| Upload check that refuses a stretched schedule; webhooks with Cadence and CipherPay signatures | ✅ in the code, with unit tests (`cargo test -p cadence-runner`) |
| Web app on an app host of its own, separate from the runners, with its build identity in the footer | Live at https://app-production-be97.up.railway.app (`VITE_API=runners`, `deploy/railway-app/`) |
| Mainnet run funded from Zodl | ✅ [`evidence/mainnet.md`](evidence/mainnet.md): a 3-payment short run, each payment mined in its target block, and a weekly mandate paying through judging |
| NU7 rehearsal: a mandate signed with NU7 pending, released across activation | ✅ on a local regtest chain, not a public network: [`evidence/nu7-regtest.md`](evidence/nu7-regtest.md). The mainnet crossing is Nov 10. |
| Free trials, fiat price labels, release jitter, payer-signed requests, access passes, refunds after a stop, re-signing, rate and body limits | In the code at this commit, with tests; not deployed. The mainnet runner stays on 7244e6a and will not get them (`docs/api.md`). |
| CI (`.github/workflows/ci.yml`): Rust tests, web checks and the WebAssembly signer built from source | The workflow is in the repository; it has not run yet |

## Evidence

- **S2 (testnet):** three installments, `7ae2c96a…`, `c0daf3c1…` and `edad440b…`. Each one is:
  - v6 on NU7 with `lock_time = 0`;
  - 0 transparent, 0 Sapling and 0 Orchard-pool parts;
  - 2 Ironwood actions with flags 7;
  - a 10,000-zat fee and a 7,264-byte proof;
  - unreadable from its outgoing ciphertexts: 0 outputs open with the zero OVK, and 0 with the pocket's own OVKs.
- **The service, testnet:** [`evidence/E2E-service-testnet.md`](evidence/E2E-service-testnet.md). A subscription runs to completion with the real runner and the CLI; a cancel stops it, and the cancel transaction decodes with 0 outputs recoverable under the pocket's own keys; in a third run the runner's sync, drand fetch and broadcasts all go over Tor.
- **The public sandbox, testnet:** [`evidence/railway-sandbox.md`](evidence/railway-sandbox.md). Three installments signed in a clean browser and released by the Railway runner; open-early and tamper attempts refused by the live runner. A first run showed a timing tell (installments mined 5 and 11 blocks after their targets); the runner now releases in the tick that opens each package, and the re-run, driven from the app host, landed 1 to 3 blocks after target with all four cheats refused.
- **Mainnet:** [`evidence/mainnet.md`](evidence/mainnet.md). Two mandates subscribed from Zodl through the app host on Oct 27. Every structural field of a Cadence installment matches the payer's own Zodl send: v6, 2 Ironwood actions, the standard fee and proof, 0 transparent, 0 readable with the zero OVK. The weekly one keeps paying through judging.
- **Contract v2 on testnet, before deploying:** [`evidence/v2-testnet.md`](evidence/v2-testnet.md). A runner from this build, the web app's payer key and access pass, a merchant stop refunded in the browser, and a CLI re-sign whose installment then mined.
- **NU7 rehearsal, local regtest:** [`evidence/nu7-regtest.md`](evidence/nu7-regtest.md), with decodes in [`nu7-regtest-decoded.json`](evidence/nu7-regtest-decoded.json). On a Zebra 7.0.0 regtest chain with NU7 at height 200, the CLI signed a 3-installment mandate at tip 193, while NU7 was still pending. The runner released installment 1 on NU6.3 and installments 2 and 3 on the NU7 branch `77190ad9`, each mined in its target block, with the default expiry of its branch. This is a local chain mined on demand, so nobody else can look these txids up; `scripts/regtest/rehearse.sh` repeats the run, and `--network regtest` works for the runner, the CLI and the decoder.
- **Fingerprint, mainnet sample:** 200 blocks (3,526,581–3,526,780) in [`evidence/fingerprint-mainnet-sample.json`](evidence/fingerprint-mainnet-sample.json).
  - The class "v6, Ironwood-only, 2 actions" is the most common shielded shape: 168 of 521 Orchard-family transactions.
  - Fee, flags, lock time, proof size and branch are identical across 100% of that class.
  - 78% are consistent with an anchor at target − 3, which is Cadence's rule.
- **Tests added on Oct 28** (`cargo test --workspace`, and `pnpm test` in `web/`):
  - privacy: the rung seed's PRF is deterministic, changes with every input, and comes from no key the runner holds; a positive control shows the decoder's OVK check finds outputs that were built with an OVK (`cadence-core/tests/privacy.rs`);
  - the scheduler's decisions, and what finishing a subscription does to the store and the wallet (`cadence-runner/src/service/scheduler_tests.rs`);
  - the chain crate's block cache, lightwalletd calls and wallet helpers;
  - jitter vectors that the Rust and web payers both check (`cadence-core/tests/schedule_vectors.json`), and payer-auth vectors on both sides;
  - the rate, body and faucet limits (`cadence-runner/src/limits.rs`, `sandbox.rs`);
  - re-signing: the same change notes under the same fee, the chain check, and the shortfall (`cadence-core/tests/resign.rs`), and the runner's checks on a re-sign.
- **Decode any transaction yourself:** `cadence-decode decode <txid>` (add `--network main` for mainnet txids), or the decoder page in the web app. The app host's decoder asks the testnet runner first, then the mainnet runner, and says which one decoded it; the mainnet runner also has [its own decoder](https://main-production-d975.up.railway.app/decode).

## Architecture

```
crates/cadence-core    pocket keys, rung ladders (DeferredPcztBuilder), mandate schedule, redaction  [native + wasm32]
crates/cadence-seal    age (runner) inside tlock (drand quicknet), zstd, fixed-size buckets            [native + wasm32]
crates/cadence-chain   lightwalletd over Tor (arti), compact-block cache, pocket wallet, prove + broadcast
crates/cadence-runner  merchant service: drand scheduler, release, confirmations, HTTP API, webhooks, access passes, limits
crates/cadence-cli     payer: subscribe / resume / cancel / sweep / resign (runner and chain over Tor), dev pocket tools
crates/cadence-decode  public-shape decoder and mainnet fingerprint scanner
crates/cadence-wasm    browser signer (Web Worker pool)
web/                   landing, payer flow, merchant dashboard, decoder, judge sandbox, brand book (strict CSP, zero third-party requests)
```

### How a rung ladder works

v6 sighashes exclude anchors but commit to expiry and branch. So each installment is signed once for every candidate broadcast height in its window, and each of these is a *rung*. One keyed seed drives every random choice, so **all rungs of an installment contain byte-identical actions** and produce the same change note. The runner broadcasts only the rung for exactly the next block. If none exists, it fails closed: it waits, or marks the installment missed once the chain is past the window, and you cancel or sweep and subscribe again (a re-sign replaces only packages that have not opened, on a subscription still active, so it cannot recover a missed installment). It never broadcasts a non-default expiry. Windows on mainnet skip the blocks just before NU7 (height 3,543,405). From the ZIP 2009 fee switch (3,590,000) rungs pay the new 2,000-zat fee, and no installment's window straddles the switch, so its rungs still agree.

## Run it

```sh
cargo build --release

# Merchant
cadence-runner init --network test
CADENCE_MERCHANT_TOKEN=… cadence-runner serve --network test

# Payer (runner calls and chain access go over Tor unless the runner is local)
# Installment 1 falls due --first-in (default 60 s) after signing, after any trial, plus up to
# a quarter period of jitter; that must stay within one period plus 600 s, or the runner refuses the upload.
# The file is written 0600; with --passphrase-file or CADENCE_KEY_PASSPHRASE it is encrypted
# as the web app's cancel key is, at a terminal you are asked, and a script with neither gets plain JSON.
cadence subscribe --runner http://127.0.0.1:8737 --offer off_… --out my-sub.json
cadence cancel --subscription my-sub.json --to <your UA>
cadence sweep  --pocket my-sub.json --to <your UA>    # recover leftovers, no runner needed
cadence resign --subscription my-sub.json --dry-run   # sign the sealed installments again (runners that list resign)
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
- **Unscheduled network upgrades invalidate rungs.** Each signature commits to the consensus branch, so a schedule that runs past an upgrade unknown at signing time must be signed again. Known boundaries are handled: windows skip the last blocks before NU7, and fees follow ZIP 2009 from height 3,590,000, which leaves the 8,000 zats each later installment saves in the pocket for `cadence sweep`. This build adds `cadence resign`: it signs the installments still sealed again under the CLI's current rules, from the pocket's live note and for the same drand rounds, and replaces their packages on a runner that lists `resign`, with a request signed by the payer's key. Its limits:
  - It needs a subscription registered with a payer key, so not one made before this build, the live mainnet mandate among them; those cancel and subscribe again.
  - It works only while the subscription is active and no installment is due or in flight, so it cannot recover a missed installment.
  - A pocket cannot be topped up, so if the new rules cost more than the pocket holds, it says by how much and the payer must cancel and subscribe again.
  - After a re-sign that changes the fee, the notes stored in a web cancel key are out of date, so /manage cannot cancel with it; `cadence cancel` and `cadence sweep` still can.
  - There is no re-sign button in the web app. It has run once on testnet, against a runner from this build on a laptop: an installment mined from a re-signed package ([`evidence/v2-testnet.md`](evidence/v2-testnet.md)).
- **The pocket is a software key.** Hardware wallets can fund it but cannot sign ladders.
- **Timing is public.** Short demo cadences are visible as a schedule. Monthly ones are a few ordinary transactions among thousands a day. In this build the payer's signer moves each installment later by its own random draw, up to a quarter period and at most 6 hours, so installments no longer fall at exact intervals; but the rough rhythm stays visible, and the runner adds no jitter of its own at release. Installment 1 falls due a minute after signing, plus its draw, so on a short period it lands a few blocks after the funding transaction. Schedules signed before this build, the live mainnet mandate's among them, have no jitter. Nothing in an installment's fields marks it as a subscription; its timing can.
- **Until its cancel key is saved, a paid pocket lives only in your tab.** The pocket's key exists only in the tab's memory until the schedule is signed and uploaded and the cancel key is saved. Closing or reloading the tab in that window, after paying, loses the funds; the page asks before a reload or close. The CLI writes its key file before you fund, readable only by you, and encrypted when it has a passphrase. A payment smaller than the QR code asks for cannot be signed, and the browser cannot yet return it, so pay the exact amount.
- **Plans can run about 45 days ahead.** Each installment's rungs travel in one sealed package, which is capped at 64 MiB; at 25-second blocks that holds the window of a payment due up to about 53 days after signing. The web app counts any trial and the most jitter towards the 45 days. Longer mandates need rolling funding or a compact ladder format, which are not built yet.
- **The runner's lightwalletd can link a mandate's transactions.** Besides compact blocks, the runner fetches each pocket's funding transaction and its own broadcasts by txid from the server it syncs with. That is over Tor, so not from your IP, but the server's operator can link a mandate's funding to its installments. `cadence cancel` and `cadence sweep` do the same through the server you choose. A node of your own avoids it.
- **Whoever serves the web app serves the code that holds your pocket key.** A runner that serves the app could serve code that steals the key; the runner software cannot. A `VITE_API=runners` build served from an origin the merchant does not control, with its commit and bundle sha256 in the footer to check against a build of your own, removes that risk, and so does the CLI. The live demo has such a host ([app-production-be97.up.railway.app](https://app-production-be97.up.railway.app), `deploy/railway-app/`), but we also run the demo's runners, so it shows the mode working, not independence from the merchant.
- **The hosting edge sees your IP, and more.** The live demo runs on Railway, which sees the address of every browser that loads it, unless you use Tor Browser. Railway terminates TLS in front of both runners, so as the host it can read request bodies, including each pocket's viewing key, and what the runners log. Opening a share link asks the runner it names for its copy of the offer, so that runner learns your IP and which offer you opened. A runner on your own server behind your own TLS, or its onion service, avoids this.
- **Rate limits are per address, and simple.** This build limits each client address per class of route (`429` with `Retry-After` past a limit), caps request bodies at 64 KiB (80 MiB for uploads and re-signs), gives the decoder its own lightwalletd connection with at most 4 decodes at once, and holds the faucet to each pocket once, 30 fundings an hour in all and 6 per client. Behind Railway the client address is the first `X-Forwarded-For` hop. On Oct 28 a forged header did not change it: requests that each claimed a different address were still counted as the sender's own (`deploy/README.md`). The buckets live in memory, so a restart or many addresses start afresh. A flood can still slow a runner. The mainnet runner stays on build 7244e6a, with no limits. Funds are never at risk, and each release has a window of an hour or more.
- **The browser's cancellation certificate takes the runner's word that the cancel was mined.** The cancel is your own transaction, so you can check its txid on any explorer or with `cadence-decode`; `cadence cancel` checks the chain itself.
- **Builds reproduce on one machine, not yet across machines.** The footer's commit and bundle hash let you compare what the host serves with its `build.json` and with a build you trust. From this commit the WebAssembly build maps the machine's paths to fixed ones, the toolchain is pinned (`rust-toolchain.toml`, Rust 1.96.0) and a patched `i18n-embed-fl` emits its output in a fixed order: two checkouts at different paths on one Mac gave the same WebAssembly and the same `bundle_sha256`. Nothing has been compared across machines, and a different clang for wasm32, such as CI's Ubuntu clang, is expected to give different bytes (`web/README.md`, "Build identity"). The bundle the app host serves as of Oct 28 was built before this, so it cannot be rebuilt byte for byte.
- **Webhooks are best-effort.** Three attempts from memory and no outbox; merchants reconcile from the API (`docs/merchant.md`).

Experimental software, not audited. The mainnet runs move small, disclosed amounts.

## License

Licensed under either of [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE), at your option.
