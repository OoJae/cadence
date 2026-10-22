# Cadence

**Subscribe once. Close the tab.** Pre-authorized shielded payments on Zcash's Ironwood pool.

Shielded Zcash can only *push*: a payment happens only while the payer's wallet is online and signs it. That rules out subscriptions, salaries, allowances and standing orders, unless you hand your funds to a custodian or keep a hot wallet running. Cadence gives shielded Zcash **pull payments without custody**:

1. **Fund once.** You fund a single-use *pocket* with one ZIP 321 QR from any Ironwood wallet (Zodl, Zkool, Vizor).
2. **Pre-sign and close the tab.** Cadence pre-signs every installment and seals each one: to a [drand](https://drand.love) round with tlock, so it cannot be opened before it is due, and to the merchant's runner with age.
3. **The runner releases each installment when it falls due.** It installs a fresh anchor, proves, and broadcasts. It **can never spend, redirect or enlarge** a payment: it holds no spending key, and every byte it broadcasts was signed by you.
4. **Cancel at any time** by spending your own pocket note. Every later installment becomes a double-spend that no node will accept.

Every installment is an ordinary v6 Ironwood transaction: 2 actions, the ZIP 317 fee, the default expiry, an anchor three blocks back, and nothing recoverable from its outgoing ciphertexts. On mainnet that is **the single most common shielded transaction shape** (see [Evidence](#evidence)).

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

The runner **cannot**:

- change an amount or recipient (the signature covers both);
- release early (the drand signature does not exist yet);
- spend the pocket any other way (it has no spending key);
- replay after a cancel (the note is gone).

When a subscription ends, the runner deletes the pocket account and its sealed packages.

## Status (Oct 22, 2026)

| Milestone | Result |
|---|---|
| S1: rung determinism, including across the NU7 boundary | ✅ `crates/cadence-core/tests/s1_determinism.rs` |
| S2: 3 chained installments, signed before their parents existed, released by a view-only runner on NU7 testnet | ✅ [`evidence/S2-testnet.md`](evidence/S2-testnet.md) |
| Full service on testnet: offer → subscribe → fund → drand release → mined | ✅ (see below) |
| Mainnet run funded from Zodl | ⏳ |

## Evidence

- **S2 (testnet):** three installments, `7ae2c96a…`, `c0daf3c1…` and `edad440b…`. Each one is:
  - v6 on NU7 with `lock_time = 0`;
  - 0 transparent, 0 Sapling and 0 Orchard-pool parts;
  - 2 Ironwood actions with flags 7;
  - a 10,000-zat fee and a 7,264-byte proof;
  - unreadable from its outgoing ciphertexts: 0 outputs open with the zero OVK, and 0 with the pocket's own OVKs.
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
crates/cadence-cli     payer: subscribe / resume / cancel, dev pocket tools
crates/cadence-decode  public-shape decoder and mainnet fingerprint scanner
crates/cadence-wasm    browser signer (Web Worker pool)
web/                   payer flow, merchant dashboard, decoder, judge sandbox (strict CSP, zero third-party requests)
```

### How a rung ladder works

v6 sighashes exclude anchors but commit to expiry and branch. So each installment is signed once for every candidate broadcast height in its window, and each of these is a *rung*. One keyed seed drives every random choice, so **all rungs of an installment contain byte-identical actions** and produce the same change note. The runner broadcasts only the rung for exactly the next block. If none exists, it fails closed and asks you to re-sign; it never broadcasts a non-default expiry. Windows on mainnet skip the blocks just before NU7 (height 3,543,405) and stop before the ZIP 2009 fee switch (3,590,000).

## Run it

```sh
cargo build --release

# Merchant
cadence-runner init --network test
CADENCE_MERCHANT_TOKEN=… cadence-runner serve --network test

# Payer
cadence subscribe --runner http://127.0.0.1:8737 --offer off_… --out my-sub.json
cadence cancel --subscription my-sub.json --to <your UA>
```

## Credits and prior art

Cadence builds on the following, and does not claim to have invented the primitive:

- [ZIP 374](https://zips.z.cash/zip-0374) (PCZT, pre-authorization with deferred anchors) and [ZIP 229](https://zips.z.cash/zip-0229) (v6 transactions).
- [ZIP 318](https://zips.z.cash/zip-0318) and librustzcash's `zcash_pool_migration`, which pre-sign height-scheduled transfers for the payer's own wallet.
- `DeferredPcztBuilder` in zcash_primitives 0.31.
- [tlock](https://eprint.iacr.org/2023/189), using drand quicknet and `tlock_age`, and [age](https://age-encryption.org).

Cadence's contribution is a **third-party executor with no spend authority**, built from:

- drand "not before";
- v6 expiry "not after";
- cancellation by self-spend;
- per-height rung ladders that match ordinary sends field for field.

As far as a GitHub search on Oct 22, 2026 shows, this is the first Zcash implementation of pre-authorized, payee-executed shielded payments with the payer offline.

## Honest limits

- **"Not before" rests on drand's threshold assumption.** `tlock_age` 0.0.10 is unaudited. Because age is the inner layer, a tlock failure only lets *the runner* open early; it can never redirect funds.
- **Network upgrades and the fee switch invalidate rungs.** Cadence re-signs before the boundary.
- **The pocket is a software key.** Hardware wallets can fund it but cannot sign ladders.
- **Timing is public.** Short demo cadences are visible as a schedule; monthly cadences with jitter hide in normal traffic.

Testnet software. Not audited.

## License

MIT OR Apache-2.0
