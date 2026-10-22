# Cadence threat model

Cadence lets a payer pre-authorize a schedule of shielded Ironwood payments that the payee's *runner* releases over time. This document states what each party can learn or do, what we built so they can't, and what remains.

"Pocket" means the single-use account a mandate is paid from. "Rung" means one pre-signed variant of an installment for a single target height.

## Assets

1. **Who pays whom.** The link between the payer's identity or main wallet and the merchant.
2. **Amounts and schedule.** How much, how often, and for how long.
3. **The payer's main wallet:** its balance, its history, and its other payments.
4. **The payer's network identity:** their IP address.
5. **The merchant's customer list:** who subscribes, and how many subscribers there are.

## Parties

| Party | Role |
|---|---|
| Chain observer | Anyone reading Zcash (or any explorer) |
| Runner | The merchant's executor. It holds the pocket's Orchard-only UFVK and the sealed packages. |
| drand relays | Serve public randomness beacons |
| lightwalletd / node operators | Serve compact blocks and accept broadcasts |
| Network observer | ISP, Wi-Fi, or a global passive adversary |
| Web host | Serves the payer app (if the payer uses the web build) |

---

## 1. Chain observer

**Sees:** an installment is a v6 Ironwood transaction. Every one has:

- 0 transparent inputs and outputs;
- no Sapling or Orchard-pool parts;
- 2 Ironwood actions (payment plus change or padding) with flags 7;
- the ZIP 317 fee (10,000 zats);
- `lock_time = 0`;
- the default expiry for its target height (+40 before NU7, +120 from NU7);
- an anchor 3 blocks behind the target;
- a standard proof size.

**Mitigation:**

- **Every field matches a fresh send.** Because v6 sighashes exclude anchors (ZIP 229 / ZIP 374), the anchor is chosen when the installment is *released*, not when it is signed, so there is no stale anchor. Expiry and branch are committed, so we sign one rung per candidate height (`crates/cadence-core/src/rung.rs`). The runner broadcasts **only** the rung for `tip + 1`, or nothing (`crates/cadence-runner/src/service.rs`, "Fail closed").
- **Nothing to decrypt with outgoing keys.** Every pocket output uses `OvkPolicy::Discard`: the builder is passed `ovk: None`, so `out_ciphertext` is random. The decoder proves this on chain: zero-OVK recoverable = 0, pocket-OVK recoverable = 0 (`evidence/*-decoded.json`).
- **Funding is shielded-to-shielded.** The payer funds from an Ironwood balance, so no amount crosses a pool boundary.
- **The shape is measured, not assumed.** On mainnet, Cadence's shape class is the most common shielded shape: 168 of 521 Orchard-family transactions in a 200-block sample. Fee, flags, lock time, proof size and branch are identical across 100% of the class, and 78% use the same anchor rule (`evidence/fingerprint-mainnet-sample.json`).

**Residual:**

- **Timing is public.** A mandate with a 2-minute cadence on a quiet chain is visible as a periodic series. Real mandates are monthly. The scheduler adds jitter (planned); at ~8k tx/day a monthly payment is not distinguishable by timing.
- **Retry tells.** If an installment expires unmined, its retry rung carries byte-identical actions. A mempool recorder could link the two broadcasts. This is rare and disclosed.

## 2. Runner (the merchant)

The runner **must** hold the pocket's Orchard full viewing key. ZIP 374's Prover role needs the spent note's full viewing key, and the alternative of proving up front would force stale, linkable anchors (§1).

**Learns:** the pocket's prepaid balance, the schedule, each installment (which it receives anyway), the change values, and that and when the payer cancelled.

**Does not learn:**

- **The payer's main wallet.** A pocket is a fresh random seed at a fixed non-zero ZIP 32 account (`POCKET_ACCOUNT = 7`, `crates/cadence-core/src/pocket.rs`), never derived from the payer's wallet. Its UFVK has no transparent or Sapling part; the runner refuses anything else (`cadence-chain/src/wallet.rs::import_pocket`).
- **Where cancelled or refunded funds went.** Discard OVK on every pocket output, verified by decoding the cancel transaction with the pocket's own UFVK: 0 recoverable (`evidence/E2E-service-testnet.md`, run 2).
- **Other subscriptions.** One pocket per mandate.
- **Anything early.** Each package is sealed to drand round `r_k` with tlock, *outside* an age layer to the runner. Before `r_k` the runner holds an opaque, bucket-padded 64 KiB blob.
- **Derivation metadata.** PCZTs pass the Redactor before upload, which removes ZIP 32 derivations (seed fingerprint), outgoing cipher keys, user-address strings and proprietary fields (`cadence-core/src/package.rs`).
- **The RNG seed.** Rung randomness comes from a keyed BLAKE2b PRF over a secret only the payer app holds (`cadence-core/src/seed.rs`).

**Cannot:**

- **Redirect or enlarge a payment.** Amount and recipient are under the spend-authorization signature; `apply_signature` and the Transaction Extractor reject any change.
- **Spend the pocket.** It never has `ask`.
- **Release early.** It needs the round's drand signature (see §3 for the trust assumption).
- **Replay after a cancel.** The note's nullifier is spent, so nodes reject the double-spend.

**Residual:**

- **The full viewing key cannot be revoked**, so the runner keeps its view of this one pocket's history. To bound this, the runner deletes the pocket account and shreds sealed packages and beacons at completion, cancel or stop (`service.rs::finish`). A malicious runner could keep copies; it still learns nothing beyond the pocket.
- **Liveness.** If the runner is offline through an installment's whole rung window, that installment is marked `missed` and the payer must re-sign. Funds never move without a valid rung, and they stay the payer's.

## 3. drand

**Trust:** "not before" relies on the drand quicknet threshold, the League of Entropy. If a threshold of nodes colluded, the runner could open a package early.

**Bounded consequence:** age is the inner layer, so an early opening can only let *the runner* release an installment early. Amounts and recipients are signed, so it can never redirect funds, and rolling funding (at most a few periods per pocket) bounds the exposure.

**Privacy:**

- **Sealing is offline.** It uses only drand's public key, so the payer never contacts drand.
- **The runner fetches beacons over Tor** (`service.rs::fetch_beacon`), so relays see neither the runner's address nor which rounds a given runner needs.
- **Every beacon is verified** against quicknet's public key before use (`cadence-seal::parse_beacon_json`).

**Software:** `tlock_age` 0.0.10 is unaudited. We found that crafted input panics it, so `cadence-seal` verifies the beacon first and catches the panic (`SealError::MalformedTimeLock`).

## 4. lightwalletd / node operators

| Mode | What the server sees |
|---|---|
| Runner with its own node | Nothing: it syncs from its own Zebra 7 node (the deployment target) |
| Runner with a public server (dev and sandbox) | Over Tor, it sees a compact-block client with no IP. Broadcasts use a separate Tor client (`--broadcast-server`, separate arti state). |
| Payer CLI | It reaches lightwalletd over Tor only to check the runner-supplied anchor against an independent tree state and to broadcast a cancel. |

## 5. Network observer

- **CLI.** Every chain contact goes over Tor (arti, embedded). Contact with the runner happens only during subscribe and cancel, and should use the runner's onion address in production.
- **Web build.** A normal browser cannot speak Tor. The web payer talks to the runner's origin over HTTPS, and this is disclosed in the UI and in the README. Tor Browser plus the onion address is the private web path. The page makes no other requests: fonts are self-hosted, there is no analytics, and the CSP pins `connect-src` to the runner. `pnpm verify` fails the build on any off-origin request.

## 6. Web host

- **Offer data never reaches the host.** It travels in the URL fragment.
- **Keys stay in the browser.** The signer runs in WebAssembly workers, and keys stay in memory. Nothing is written to browser storage; `pnpm verify` asserts zero storage writes.
- **The CSP is strict.** No inline script, no eval except `wasm-unsafe-eval`, and Trusted Types are required.

---

## Claims we do not make

- "No viewing keys on any server." The runner holds one pocket's Orchard FVK, scoped as above.
- "Trustless timing." "Not before" is a drand threshold assumption.
- "Indistinguishable" beyond the fields we measure and publish. We say "matches stock sends on every measured field".
- "Tor everywhere" for the plain web build.
- "First pull payments on any chain." We claim only the first Zcash implementation we could find (GitHub search, Oct 22 2026).
- Post-quantum privacy. ZIP 2005 is about recoverability, not privacy.

## Checklist (what a judge can verify)

| Claim | How to check |
|---|---|
| Ironwood-only, 2 actions, standard fee and expiry | `cadence-decode decode <txid>`, or the web decoder |
| Nothing recoverable with zero or pocket OVKs | `cadence-decode decode <txid> --ufvk <pocket ufvk>` |
| Shape matches the mainnet population | `cadence-decode scan --network main --from … --to … --compare <txid>` |
| Rungs are deterministic (same actions at every height, across NU7) | `cargo test -p cadence-core` |
| Sealing works as described: wrong round, wrong identity and tampering all fail | `cargo test -p cadence-seal` |
| Cancel stops the schedule | `evidence/E2E-service-testnet.md`, run 2 |
