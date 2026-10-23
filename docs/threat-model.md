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
- the ZIP 317 fee (10,000 zats; 2,000 from ZIP 2009's mainnet switch at height 3,590,000, as ZIP 2009 tells wallets to pay);
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

- **Timing is public.** A mandate with a 2-minute cadence on a quiet chain is visible as a periodic series. Real mandates are monthly. Cadence adds no jitter yet: each installment goes out at the first block after its drand round in which its input is 3 blocks deep. A monthly series is still a handful of 2-action transactions among thousands a day, but an observer who guesses the schedule can test it.
- **Retry tells.** If an installment expires unmined, its retry rung carries byte-identical actions. A mempool recorder could link the two broadcasts. This is rare and disclosed.

## 2. Runner (the merchant)

The runner **must** hold the pocket's Orchard full viewing key. ZIP 374's Prover role needs the spent note's full viewing key, and the alternative of proving up front would force stale, linkable anchors (§1).

**Learns:** the pocket's prepaid balance, the schedule, each installment (which it receives anyway), the change values, and that and when the payer cancelled. Each installment's memo reads like "Cadence · Pro plan (pkt_…) · payment 2 of 3": ZIP 302 text for the merchant's own wallet, carrying nothing the merchant does not already know.

**Does not learn:**

- **The payer's main wallet.** A pocket is a fresh random seed at a fixed non-zero ZIP 32 account (`POCKET_ACCOUNT = 7`, `crates/cadence-core/src/pocket.rs`), never derived from the payer's wallet. Its UFVK has no transparent or Sapling part; the runner refuses anything else (`cadence-chain/src/wallet.rs::import_pocket`).
- **Where cancelled or refunded funds went.** Discard OVK on every pocket output, verified by decoding the cancel transaction with the pocket's own UFVK: 0 recoverable (`evidence/E2E-service-testnet.md`, run 2).
- **Other subscriptions.** One pocket per mandate.
- **Anything early.** Each package is sealed to drand round `r_k` with tlock, *outside* an age layer to the runner. Before `r_k` the runner holds an opaque blob padded to a size bucket (64 KiB × 2ⁿ), so its length reveals only the bucket.
- **Derivation metadata.** PCZTs pass the Redactor before upload, which removes ZIP 32 derivations (seed fingerprint), outgoing cipher keys, user-address strings and proprietary fields (`cadence-core/src/package.rs`).
- **The RNG seed.** Rung randomness comes from a keyed BLAKE2b PRF over a secret only the payer app holds (`cadence-core/src/seed.rs`).

**Cannot:**

- **Redirect or enlarge a payment.** Amount and recipient are under the spend-authorization signature; `apply_signature` and the Transaction Extractor reject any change.
- **Spend the pocket.** It never has `ask`.
- **Release early.** It needs the round's drand signature (see §3 for the trust assumption).
- **Replay after a cancel.** The note's nullifier is spent, so nodes reject the double-spend.

**The merchant is protected too.** The runner checks every opened rung against the offer before it broadcasts: the installment index and amount, an output to the merchant's Orchard receiver whose note commitment matches that amount, the branch, `lock_time = 0` and the default expiry (`cadence-core::package::verify_rung`). A package that fails is marked `invalid` and nothing is sent. The runner does not check that the payment's ciphertext decrypts for the merchant: a payer who corrupts it loses that installment, but the merchant's wallet will not show it, so a merchant that needs proof of receipt should check its own wallet. Before calling a subscription cancelled, the runner rules out its own missed confirmation and a reorg, by checking with lightwalletd that its last broadcast is not mined and that the input's parent still is.

**Residual:**

- **The full viewing key cannot be revoked**, so the runner keeps its view of this one pocket's history. To bound this, at completion, cancel or stop the runner deletes the pocket's wallet account, its UFVK, its funding transaction, and the sealed packages and beacons (`service.rs::finish`, `store.rs::shred`). Both databases run with SQLite `secure_delete`. The state database is rewritten (`VACUUM`) and its WAL emptied after each shred, and the wallet is rewritten at each start, so no free page keeps a copy. This works at the file level only: a copy-on-write filesystem or an SSD may keep older blocks, so the runner's disk should be encrypted. Pockets nobody subscribed with are forgotten after a day (unfunded) or a week (funded). A malicious runner could keep copies; it still learns nothing beyond the pocket.
- **Funds the runner never releases stay the payer's.** After a stop, or when a pocket was overfunded, the remainder sits in the pocket. Only the payer holds its spending key, and `cadence sweep` returns it by scanning the chain over Tor, with no help from the runner.
- **Liveness.** If the runner is offline through an installment's whole rung window, that installment is marked `missed`; the payer can cancel or sweep and subscribe again. Funds never move without a valid rung, and they stay the payer's.

## 3. drand

**Trust:** "not before" relies on the drand quicknet threshold, the League of Entropy. If a threshold of nodes colluded, the runner could open a package early.

**Bounded consequence:** age is the inner layer, so an early opening can only let *the runner* release an installment early. Amounts and recipients are signed, so it can never redirect funds. The worst case is that this mandate's own remaining installments are paid ahead of schedule. A payer who wants a smaller exposure subscribes for fewer periods at a time; Cadence does not yet roll funding automatically.

**Privacy:**

- **Sealing is offline.** It uses only drand's public key, so the payer never contacts drand.
- **The runner fetches beacons over Tor** (`service.rs::fetch_beacon`), including when it syncs from its own node with `--direct`. Relays see which rounds are requested, but not from where. `--drand-direct` turns this off for development.
- **Every beacon is verified** against quicknet's public key before use (`cadence-seal::parse_beacon_json`).

**Software:** `tlock_age` 0.0.10 is unaudited. We found that crafted input panics it, so `cadence-seal` verifies the beacon first and catches the panic (`SealError::MalformedTimeLock`).

## 4. lightwalletd / node operators

| Mode | What the server sees |
|---|---|
| Runner with its own node | Nothing: it syncs from its own Zebra 7 node (the deployment target) |
| Runner with a public server (dev and sandbox) | Over Tor, it sees a compact-block client with no IP. Broadcasts use a separate Tor client (`--broadcast-server`, separate arti state). |
| Payer CLI | Over Tor, it checks the runner-supplied anchor against an independent tree state and broadcasts a cancel. `cadence sweep` scans the pocket's history from its funding height, as any light wallet does, to recover funds without the runner. |

## 5. Network observer

- **CLI.** Every chain contact goes over Tor (arti, embedded), and so does every request to the runner, on circuits isolated from the chain traffic. The one exception is a runner on the same machine, which Tor cannot reach. `--direct` turns Tor off for development. Contact with the runner happens only during subscribe and cancel.
- **Web build.** A normal browser cannot speak Tor. The web payer talks to the runner's origin over HTTPS, and this is disclosed in the UI and in the README. Tor Browser plus the onion address is the private web path. The page makes no other requests: fonts are self-hosted, there is no analytics, and the CSP pins `connect-src` to the runner. `pnpm verify` fails the build on any off-origin request.

## 6. Web host

- **Offer data never reaches the host.** It travels in the URL fragment.
- **Keys stay in the browser.** The signer runs in WebAssembly workers, and keys stay in memory. Nothing is written to browser storage; `pnpm verify` asserts zero storage writes. So that a payer can close the tab and still cancel, the app offers a **cancel key**: the pocket seed and schedule, encrypted in a worker to a passphrase with age's scrypt recipient, saved as a file the payer downloads. The browser's Manage page and `cadence cancel` / `cadence sweep` all open it. Anyone with the file and the passphrase can cancel and take the remainder; the merchant and the runner never see it.
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
| Funds are recoverable without the runner | `cadence sweep --pocket <file> --to <your UA>` |
| The runner refuses packages that don't match the offer | `cargo test -p cadence-core` (`verify_rung`) |
