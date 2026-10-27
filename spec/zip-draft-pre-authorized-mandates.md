    ZIP: Unassigned
    Title: Pre-Authorized Shielded Payment Mandates on the Ironwood Pool
    Owners: Cadence authors <https://github.com/OoJae/cadence>
    Status: Draft
    Category: Wallet
    Created: 2026-10-22
    License: MIT


# Terminology

The key words "MUST", "MUST NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED" and "MAY" in this document are to be interpreted as described in BCP 14 [^BCP14] when, and only when, they appear in all capitals.

"Ironwood pool", "v6 transaction", "effecting data" and "authorizing data" are used as in ZIP 229 [^zip-0229]. The PCZT roles (Creator, IO Finalizer, Updater, Redactor, Prover, Signer, Transaction Extractor) are those of ZIP 374 [^zip-0374].

Each requirement in this document is labelled with its implementation status in the reference implementation (§ Reference Implementation): **[impl]** means implemented as specified, **[partial]** means implemented with the deviation noted, and **[not impl]** means not yet implemented. Statements marked *Choice* are parameters of the reference implementation, not requirements of the protocol.

- **Payer**: the party whose funds are paid out. The payer holds the only spending key.
- **Merchant**: the payee.
- **Runner**: a service operated by the merchant. It stores sealed Packages and releases Installments. It holds the Pocket's full viewing key and no spending key. In ZIP 374 terms it acts as Updater, Prover and Transaction Extractor.
- **Pocket**: a single-use Orchard-protocol account that funds exactly one Mandate (§ Pocket).
- **Mandate**: the payer's authorization for `count` payments of `amount` zatoshis to one merchant receiver, each releasable no earlier than a scheduled time.
- **Offer**: the merchant's published terms for a Mandate (§ Offer).
- **Installment *k***: the *k*-th payment of a Mandate, 1 ≤ *k* ≤ `count`.
- **Input note *N_k***: the note that Installment *k* spends. *N_1* = *F*, the funding note. For *k* ≥ 2, *N_k* = *C(k−1)*.
- **Change note *C(k)***: the output of Installment *k* that returns the remaining value to the Pocket. It is absent when that value is zero.
- **Live note**: the single unspent Pocket note between installments, that is, *N_k* for the lowest unmined *k*.
- **Target height**: the height of the block a transaction is built for. A stock wallet uses tip + 1.
- **δ(h)**: the default expiry delta at height *h*. It is 40 blocks before NU7 activation (ZIP 203 [^zip-0203]) and 120 blocks from NU7 activation (ZIP 218 [^zip-0218]).
- **Rung**: Installment *k* built and signed for one target height *T*. Its expiry height is *T* + δ(*T*), it uses the consensus branch in effect at *T*, and its Ironwood anchor and spend witness are left absent.
- **Ladder** (rung ladder): the rungs of one Installment, one for each height in its Window.
- **Window *W_k***: the set of target heights for which Installment *k* is signed (§ Windows).
- **Package**: one Installment's Ladder, redacted, encoded and sealed (§ Packages).
- **Release round *r_k***: the drand quicknet round that Package *k* is time-locked to.
- **Anchor-deep**: a note mined at height *m* is anchor-deep for target *T* if *m* ≤ *T* − 3.
- **Discard**: building an output with no outgoing viewing key (`ovk = None`, `OvkPolicy::Discard` in librustzcash). The output's `out_ciphertext` then decrypts under no key.
- **Fail closed**: when no permitted action exists, the Runner broadcasts nothing.
- **tip**: the best-chain height as currently seen by the party in question.
- **LE32(x)**, **LE64(x)**, **BE64(x)**: *x* as a 4-byte little-endian, 8-byte little-endian or 8-byte big-endian integer. **||** is byte concatenation.


# Abstract

This ZIP specifies Cadence, a wallet-level protocol for pre-authorized ("pull") shielded payments. A payer funds a single-use Pocket once, then signs every installment of a Mandate in advance and goes offline. The merchant's Runner releases each installment when it falls due. The Runner holds the Pocket's full viewing key but no spending key, so it cannot change an amount or recipient, cannot spend the Pocket any other way, and cannot open an installment before its drand round.

The construction relies on the v6 transaction format. Its signature hash excludes the shielded anchors but commits to the expiry height and consensus branch. Each installment is therefore signed once per candidate broadcast height (a *rung*). One keyed seed drives every random choice, so all rungs of an installment contain byte-identical actions and produce the same change note. That lets installment *k*+1 be signed before installment *k* is mined. At release time the Runner installs a fresh anchor three blocks behind the target and proves. It broadcasts only the rung for exactly the next block, or nothing. Each Ladder is sealed with age to the Runner, inside a tlock time-lock to a drand round. The payer cancels by spending the Pocket's live note, after which no later installment can be mined.

Every installment is an ordinary v6 Ironwood transaction: 2 actions, the ZIP 317 fee (with ZIP 2009's lower marginal fee from its Mainnet height), the default expiry and an anchor three blocks back.


# Motivation

A shielded payment happens only while the payer's wallet is online and signs it. Subscriptions, salaries, allowances and standing orders therefore need either a custodian or an always-online hot wallet. Both are worse for privacy and safety than the payment itself.

ZIP 374 [^zip-0374] and ZIP 229 [^zip-0229] make pre-authorization possible: a v6 transaction can be signed before its anchor exists, and its proof can be computed later. ZIP 318 [^zip-0318] and `zcash_pool_migration` [^pool-migration] use this for transfers that the user's own wallet schedules and broadcasts. This ZIP addresses the case where the *payee's* service executes the schedule while the payer is offline, without spend authority and without producing transactions that differ from ordinary sends.


# Requirements

1. After funding and signing, the payer can go offline for the life of the Mandate.
2. The Runner cannot change any installment's amount, recipient or memo, cannot pay itself more than the signed amounts, and cannot spend Pocket funds in any other way.
3. The Runner cannot open an installment, and so cannot release it, before its scheduled time. This holds under a stated threshold assumption about drand.
4. No installment can be mined after a height that is fixed at signing time.
5. The payer can cancel unilaterally, and the cancellation is enforced by consensus.
6. On every public field measured (§ Privacy Implications), each installment matches the most common class of ordinary shielded sends.
7. The Runner learns nothing about the payer's main wallet beyond what the funding transaction makes public.
8. Each Package reveals only its release round, its drand chain and a size bucket until that round is published.


# Non-requirements

- Hiding the amount, schedule or cancellation from the merchant, who is the payee.
- Trustless timing. "Not before" rests on drand quicknet's threshold assumption.
- Hiding the payment cadence from a chain observer who knows the period (§ Privacy Implications, *Timing residual*).
- Variable or usage-based amounts. Amounts are fixed at signing time.
- Signing Ladders with hardware wallets. A hardware wallet can fund a Pocket but cannot reasonably sign hundreds to tens of thousands of sighashes.
- Transparent or Sapling sources. Sapling nullifiers depend on tree position, so Sapling spends cannot defer their witnesses (ZIP 374), and `DeferredPcztBuilder` supports only the Orchard-family pools.
- Post-quantum privacy. ZIP 2005 [^zip-2005] addresses recoverability, not privacy.
- Any consensus change.


# Specification

## Constants

| Name | Value | Where |
|---|---|---|
| `POCKET_ACCOUNT` | 7 | `cadence-core/src/pocket.rs` |
| `ANCHOR_CONFIRMATIONS` | 3 | `cadence-chain/src/wallet.rs` |
| `PRE_NU7_BLOCK_SECS`, `NU7_BLOCK_SECS` | 75, 25 | `cadence-core/src/mandate.rs`; ZIP 218 |
| NU7 activation height | Mainnet 3,543,405; Testnet 4,465,026 | ZIP 259 [^zip-0259]; `zcash_protocol` 0.11.0 |
| Consensus branch IDs | NU6.3 `0x37A5165B`; NU7 `0x77190AD9` | `cadence-core/tests/s1_determinism.rs`; ZIP 259 |
| δ(*h*) | 40 before NU7; 120 from NU7 | ZIP 203, ZIP 218; `zcash_primitives` 0.31.0 `default_tx_expiry_delta` |
| `NU7_GUARD_BLOCKS` | 10, Mainnet only | `mandate.rs` |
| `MAINNET_FEE_SWITCH` | 3,590,000, Mainnet only | `mandate.rs`; ZIP 2009 [^zip-2009] |
| Installment fee at target *T* | 2 × the marginal fee for *T*: 5,000, or 1,000 on Mainnet from `MAINNET_FEE_SWITCH`. So 10,000 or 2,000 zatoshis | `rung.rs::fee_rule_at`, `mandate.rs::installment_fee_at`; ZIP 317 [^zip-0317], ZIP 2009 |
| `fee_inst` (funded per installment) | 10,000 zatoshis, the highest installment fee | `mandate.rs::installment_fee` |
| Offer `count` range | 1 ≤ `count` ≤ 12 (Runner policy) | `cadence-runner/src/api.rs` |
| Upload schedule tolerance | first release ≤ upload time + `period_secs` + 600 s; each later gap within `period_secs` ± ⌊`period_secs` / 2⌋ (Runner policy) | `api.rs::check_schedule`, `FIRST_RELEASE_SLACK_SECS` |
| PRF personalizations | `"Cadence_AppSecrt"`, `"Cadence_RungSeed"` (16 bytes each) | `cadence-core/src/seed.rs` |
| Frame magic | `"CDS1"` | `cadence-seal/src/seal.rs` |
| `BUCKETS` | 65,536 × 2^*n* bytes, *n* = 0…9 (64 KiB to 32 MiB) | `seal.rs` |
| `MAX_PLAINTEXT_LEN` | 67,108,864 bytes (64 MiB) | `seal.rs` |
| zstd level | 10 with C zstd (`zstd-native`); ruzstd `Fastest` otherwise (wasm32) | `seal.rs` |
| drand chain | quicknet, `bls-unchained-g1-rfc9380`; hash `52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971`; genesis 1,692,803,367; period 3 s | `cadence-seal/src/drand.rs` |
| Runner evaluation interval | 10 s (default `--tick`) | `cadence-runner/src/main.rs` |
| Checkpoint search depth | 100 blocks | `wallet.rs::anchor_and_witness` |
| Abandoned-pocket timeouts | 1 day if unfunded; 7 days if funded with no subscription; both from registration | `cadence-runner/src/service.rs::forget_abandoned` |
| Recovery kit | age scrypt recipient, work factor 17 (at most 22 accepted when opening); passphrase of at least 8 characters | `cadence-seal/src/kit.rs` |


## Pocket

A Pocket is derived from a seed *S* of 32 bytes drawn from a CSPRNG.

- *S* MUST be generated freshly for each Mandate. It MUST NOT equal, or be derived from, any seed of the payer's main wallet. [impl]
- *sk_P* is the Orchard ZIP 32 [^zip-0032] spending key at path m_Orchard / 32′ / *coin_type*′ / 7′. *coin_type* is the SLIP 44 coin type: 133 on Mainnet and 1 on Testnet. *fvk_P* is its full viewing key and *ask_P* its spend authorizing key. [impl]
- The **funding receiver** is the external-scope address of *fvk_P* at diversifier index 0. The **funding address** is a ZIP 316 [^zip-0316] Unified Address that contains only that Orchard receiver and no metadata. [impl]
- The **change receiver** is the internal-scope address of *fvk_P* at diversifier index 0. [impl]
- The **pocket UFVK** is a ZIP 316 UFVK that contains only the Orchard FVK item *fvk_P*. [impl]
- The Runner MUST reject a pocket UFVK that contains a P2PKH, P2SH or Sapling item, or that lacks an Orchard item. [impl: `cadence-chain/src/wallet.rs::import_pocket`]
- A Pocket MUST back at most one Mandate, and its addresses MUST NOT be reused after the Mandate ends. The Runner MUST refuse a second subscription for the same Pocket. [impl]
- *Choice:* the account index is 7. Any non-zero account is acceptable (see Rationale).

*S* is raw entropy, not a BIP 39 mnemonic, so no stock wallet can restore a Pocket. Payer software MUST retain *S* for the life of the Mandate, and until the Pocket is empty, because cancellation and recovery need *ask_P*. The reference CLI writes *S* to the subscription file unencrypted.

A **recovery kit** is that file encrypted to a passphrase with age's scrypt recipient (§ Constants). The CLI's `cancel` and `sweep` accept a plaintext file or a kit (`cadence-cli/src/subscribe.rs::read_kit`). The web app offers a kit, which it calls a cancel key, for download once the Packages are uploaded, and has the payer open the downloaded file once with its passphrase before it says the tab can be closed; it checks that the kit's network, pocket id and address match the Pocket and that its seed derives that address. Its Manage page opens a kit to cancel in the browser.


## Offer

The Runner publishes an Offer. The payer fetches it (`GET /api/offers/{id}`) and signs against it.

| Field | Type | Meaning | Where it ends up |
|---|---|---|---|
| `offer_id` | `"off_"` + 20 hex digits | Runner identifier | subscription upload |
| `name` | string | display | the memo, through the label the reference payers choose (§ Memo) |
| `amount_zat` | u64 > 0 | amount of each installment | value of the merchant output (signed) |
| `period_secs` | u64 > 0 | spacing between release times | `release_at(k)` |
| `count` | u32, 1 to 12 | number of installments | Ladders; `funding_total` |
| `merchant_ua` | Unified Address with an Orchard receiver | payee | recipient of the merchant output: its Orchard receiver (signed) |
| `runner_age_recipient` | age X25519 recipient (`age1…`) | inner sealing layer | Packages |
| `runner_endpoint` | URL | where the payer reaches the Runner | nowhere |
| `network` | `"main"` or `"test"` | consensus parameters | everything |
| `drand_chain` | hex chain hash | outer sealing layer | Packages. The web payer rejects any value other than quicknet; the CLI ignores the field and always seals to quicknet. |

The payer chooses these values, which are not part of the Offer:

- `first_release_at`, a unix time. The reference CLI sets it to the signing time plus `--first-in`, which defaults to 60 s; the web signer uses min(`period_secs`, 60 s). The reference Runner refuses an upload whose first release is more than `period_secs` + 600 s after it (§ Subscription).
- `mandate_id`, 16 random bytes.
- `label`, a string shown in the memo (§ Memo). The reference CLI and web signer set it to "`name` (`pocket_id`)".
- *S*.

Release times are `release_at(k) = first_release_at + (k − 1) · period_secs`.


## Funding

    fee_inst      = 10,000 zatoshis                -- the highest installment fee
    funding_total = count · (amount_zat + fee_inst)

The payer funds the funding address with one payment of `funding_total` from an Ironwood balance. Payer software SHOULD present that payment as a ZIP 321 [^zip-0321] URI, `zcash:<funding address>?amount=<decimal ZEC>`. [impl]

The Runner records as the funding note *F* the earliest-mined unspent Pocket note. The payer decrypts *F* from the raw funding transaction using the external IVK and requires its recipient to be the funding receiver. Payer software MUST refuse to sign if value(*F*) < `funding_total`. [impl]

Installment `count` has a non-zero change note, which stays in the Pocket, if value(*F*) > `funding_total` or if any installment pays the 2,000-zatoshi fee (§ Guard bands): each such installment leaves 8,000 zatoshis more in its change. See § Cancellation for how that residue is recovered.


## Installments and rungs

Installment *k* consists of (*N_k*, `amount_zat`, the merchant's Orchard receiver, *memo_k*).

### Rung construction

Given network parameters, a target height *T*, the Pocket, Installment *k* and a seed *σ_k*, a rung is built as follows. This is the reference `cadence-core/src/rung.rs::build_rung`.

1. Create a `DeferredPcztBuilder` for *T*, with `BundlePadding::DEFAULT` for both the Orchard and Ironwood pools. The transaction version is the one suggested for branch(*T*), and it MUST be v6; the builder refuses earlier formats. The expiry height MUST be *T* + δ(*T*). The builder's default is used, with no override.
2. Add one Ironwood spend of *N_k* with *fvk_P*, without a witness. *N_k* MUST be a note of version V3, the Ironwood note plaintext format whose lead byte is `0x03` (ZIP 2005).
3. Add the merchant output: recipient = the merchant's Orchard receiver, value = `amount_zat`, memo = *memo_k*, `ovk = None`.
4. Compute `fee` with the ZIP 317 fee rule for *T* over the builder's action count, padding included. The rule has 2 grace actions and the standard P2PKH sizes, and a marginal fee of 5,000, or 1,000 on Mainnet when *T* ≥ 3,590,000 (ZIP 2009). The reference builds it with `FeeRule::non_standard` (`zcash_primitives` feature `non-standard-fees`; `rung.rs::fee_rule_at`). The count is always 2, so `fee` = 10,000, or 2,000 from the switch.
5. Compute `change = value(N_k) − amount_zat − fee`. It MUST be ≥ 0. If `change > 0`, add an output to the change receiver with value `change`, the empty memo (`0xF6` followed by 511 zero bytes) and `ovk = None`.
6. Build the PCZT parts with `ChaCha20Rng::from_seed(σ_k)` (rand 0.10). The anchor and witness stay absent.
7. Run the Creator, the IO Finalizer and the Signer. The Signer signs the real spend with *ask_P* over the v6 shielded sighash. The reference takes the randomness for the IO Finalizer and for the signatures from the system RNG. Signatures are authorizing data and differ between rungs anyway.
8. Record the index of the spend action and *C(k)*: output index 1, if present. *C(k)* is rebuilt as Note(recipient, value, ρ = the nullifier of the spend in the same action, rseed, V3), and its `cmx` MUST match.

Every rung MUST have these properties:

- **P1 (rung invariance).** For a fixed Installment *k* and seed *σ_k*, the Ironwood actions MUST be byte-identical for every *T* in *W_k*. This covers `cv_net`, `nf`, `rk`, `cmx`, `epk`, `enc_ciphertext` and `out_ciphertext`, and the order of the actions. It holds across a network upgrade too. Only the expiry height, the branch ID, the sighash and the signatures may differ. *C(k)* therefore does not depend on which rung of *k* is mined, and that is what lets *k*+1 be signed in advance. P1 does not hold across the Mainnet fee switch, where the fee and so the change differ; that is why no *W_k* contains heights on both sides of it (§ Guard bands). [impl: `crates/cadence-core/tests/s1_determinism.rs`. The S1 test covers Mainnet heights 3,530,000 and 3,530,001 (NU6.3) and 3,543,405 (NU7). `rungs_after_the_fee_switch_pay_the_zip_2009_fee_and_still_agree` covers 3,590,000, 3,590,001 and 3,590,500, which pay 2,000 and share actions and change, against 3,589,999, which pays 10,000.]
- **P2 (shape).**
  - The transaction is v6, with `lock_time = 0`.
  - It has no transparent, Sapling or Orchard-pool component.
  - It has exactly 2 Ironwood actions: payment and change, or payment and padding.
  - Its Ironwood value balance equals the fee.
  - Its expiry height is *T* + δ(*T*).

  [impl]
- **P3 (Discard).** Every output MUST use `ovk = None`. [impl]

### Builder randomness

    app_secret = BLAKE2b-256(key = sk_P (32 bytes),
                             personal = "Cadence_AppSecrt",
                             input = "rung-prf")                      -- 8 ASCII bytes
    σ_{k,a}    = BLAKE2b-256(key = app_secret,
                             personal = "Cadence_RungSeed",
                             input = mandate_id || LE32(k) || LE32(a))

Here *a* is the re-signing attempt. The reference implementation always uses *a* = 0, and the parameter is reserved for § Re-signing. *σ_k* means *σ_{k,0}*. [impl: `seed.rs`]

Requirements:

- *σ_k* MUST be computable only from payer-held secrets.
- *σ_k* MUST be identical for all rungs of Installment *k*, and MUST differ between installments and between attempts.

The derivation above is RECOMMENDED but not required for interoperability, because no other party ever recomputes *σ*.

P1 also depends on how the builder consumes the RNG output, and that is implementation-defined. The reference uses `zcash_primitives` 0.31.0 and `orchard` 0.16.0. All rungs of an Installment MUST therefore be produced by the same builder implementation. Payer software that later needs *C(k)* MUST use that same implementation, keep a copy of *C(k)*, or decrypt it from the chain. The web app keeps a copy in its recovery kit; the reference CLI decrypts the live note from the transaction that created it (§ Cancellation).

### Memo

    memo_k = UTF-8("Cadence · " || label' || " · payment " || k || " of " || count)
           = UTF-8("Cadence · payment " || k || " of " || count)     if label' is empty
    -- zero-padded to 512 bytes; k and count in decimal

*label'* is `label` with control characters removed, cut on a character boundary so that the memo fits in 512 bytes, then trimmed of surrounding whitespace. [impl: `mandate.rs::installment_memo`]

The memo is ZIP 302 [^zip-0302] text: its first byte is `C` (≤ `0xF4`) and it is valid UTF-8, so the merchant's wallet shows it, for example "Cadence · Pro plan (pkt_…) · payment 2 of 3". The CLI and the web signer use the label "`name` (`pocket_id`)"; the development `cadence presign` command uses the empty label. The memo is inside `enc_ciphertext`, which on chain only the merchant's viewing key decrypts; the Runner, which is the merchant's, can also read it from the PCZT. With Discard, `out_ciphertext` opens to no one. It tells the merchant nothing it does not already know.

### Change chaining

*N_1* = *F* and *N_{k+1}* = *C(k)*. Presigning MUST fail if *C(k)* is absent for some *k* < `count`. [impl]

Every installment is signed at subscription time, before *N_k* exists on chain for any *k* ≥ 2. This is possible because Orchard-protocol nullifiers depend only on the note and *nk*, not on the note's position in the tree. It also means that installment *k*+1 cannot be mined until *C(k)* is.


## Windows

### Height prediction

Let *A* be the NU7 activation height. Let *tip_s* and *now_s* be the tip and the unix time at signing.

    predict(tip_s, now_s, at):
        r ← max(at − now_s, 0)
        h ← tip_s
        if A is defined and h < A:
            if r ≤ (A − h)·75: return h + ⌊r / 75⌋
            r ← r − (A − h)·75
            h ← A
        return h + ⌊r / 25⌋

When *A* is undefined, 25 s spacing is assumed from *tip_s*. That quirk does not arise on Mainnet or Testnet, both of which define *A*.

The reference CLI sets *tip_s* = max(the tip reported by the Runner, the funding height). The payer therefore trusts the Runner's tip, but a wrong value can only affect liveness.

### Window

    W_k:
        p      ← predict(tip_s, now_s, release_at(k))
        a      ← p − tip_s
        s      ← ⌊4·√a⌋                         -- binary64, truncated
        below  ← 10  + s + ⌊a / 100⌋
        above  ← 150 + s + ⌊a / 50⌋
        start  ← max(p − below, tip_s + 1)      -- p − below saturates at 0
        W_k    ← { h ∈ [start, p + above] : h ∉ Excluded, side(h) = side(p) }

    side(h) = (network is Mainnet and h ≥ 3,590,000)     -- the ZIP 2009 fee switch

Presigning MUST fail with `EmptyWindow(k)` if *W_k* is empty. [impl: `mandate.rs::window`, `after_fee_switch`, `presign`] *Choice:* the constants 10, 150, 4, 100 and 50 are tuning parameters.

The window is asymmetric on purpose:

- If the chain is **behind** the prediction at release time, the rungs below *p* let the payment go out on time. Without them the Runner would only wait.
- If the chain is **ahead** of the prediction, or the release is late because the Runner was down, the previous installment was slow or a broadcast expired, a missing rung means a missed installment. The upper margin is therefore wider.

The comment in `mandate.rs` gives the opposite reason for the lower margin ("in case blocks come fast").

Window sizes at 25 s spacing with no exclusions, computed from the formula:

| Release time after signing | *a* (blocks) | below | above | rungs |
|---|---|---|---|---|
| 60 s | 2 | 15 | 155 | 157 |
| 1 day | 3,456 | 279 | 454 | 734 |
| 30 days | 103,680 | 2,333 | 3,510 | 5,844 |
| 330 days | 1,140,480 | 15,685 | 27,230 | 42,916 |

Run 1 of `evidence/E2E-service-testnet.md` reports 157, 167 and 175 rungs. The formula gives exactly those counts for offsets of 60 s, 180 s and 300 s, which is what the CLI default `--first-in 60` gives with a 120 s period.

### Guard bands

`Excluded` is empty on Testnet. On Mainnet it is:

    Excluded = { h : 3,543,395 ≤ h ≤ 3,543,404 }    -- [A − 10, A)

The band and the side rule are *Choices*. [impl: `mandate.rs::excluded`, `mandate.rs::window`]

- **NU7 band.** The last pre-NU7 rung targets 3,543,394, so every pre-NU7 rung has at least 10 blocks in which to be mined before activation makes its branch ID invalid. (ZIP 259 notes that v5 and v6 signatures commit to the branch ID.) The band does *not* keep expiry windows from straddling the upgrade. For example, a rung for *T* ∈ [3,543,365, 3,543,394] has expiry *T* + 40 ≥ 3,543,405, yet it cannot be mined at or after 3,543,405 (§ Deployment).
- **Fee switch.** ZIP 2009 says wallets SHOULD use `marginal_fee = 1000` from Mainnet height 3,590,000, which makes the conventional fee for 2 actions 2,000 zatoshis. ZIP 2009 changes relay policy, not consensus: a 10,000-zatoshi installment after the switch would still be valid, but it would pay 5× the new conventional fee and stand out. Each rung therefore pays the fee for its own target height (§ Rung construction), and each *W_k* keeps to the side of the switch on which its predicted height *p* lies, so all rungs of *k* pay one fee and share *C(k)* (P1). [impl; test `mandate.rs::mainnet_windows_keep_to_one_side_of_the_fee_switch`]

  The cost of the side rule: if *p* lies just below the switch, *W_k* ends at 3,589,999, and *k* is missed if the chain reaches the switch before *k* is released. If *p* lies just above, *W_k* starts at 3,590,000, and *k* waits for the switch even when the chain is behind.

  Funding still covers 10,000 per installment, so each installment after the switch leaves 8,000 zatoshis in the Pocket (§ Funding). Whether stock wallets actually pay 2,000 from that height is up to them, since ZIP 2009 says SHOULD; Cadence follows the ZIP. ZIP 2009 gives no Testnet height, so Testnet installments pay 10,000.


## Packages

### Ladder encoding

Each Package's plaintext is the UTF-8 JSON encoding of an `InstallmentLadder` (`cadence-core/src/package.rs`):

    { "k":                u32,
      "amount_zat":       u64,
      "spends_nullifier": hex(nf(N_k)),          -- 32 bytes, 64 lowercase hex, unreversed
      "rungs": [ { "target_height": u32,
                   "expiry_height": u32,
                   "pczt":          hex(PCZT serialization after redaction) }, … ] }

`rungs` is in strictly increasing `target_height` order. [impl] The `Ladder` wrapper, which adds `network` and `mandate_id`, is used only by the development `presign` command and is never sent to a Runner.

### Redaction

Before serialization, every rung's PCZT MUST pass the Redactor. The Redactor clears the following fields, whether or not a builder populated them. [impl: `package.rs::redact_for_runner`]

- Global: all proprietary fields.
- For each Ironwood action:
  - the spend's `zip32_derivation`, including the seed fingerprint;
  - the spend's proprietary fields;
  - the output's `zip32_derivation`;
  - the output's `ock`;
  - the output's `user_address`;
  - the output's proprietary fields.

The fields that remain are those the Prover and Transaction Extractor need:

- the spend's `fvk`, `value`, `recipient`, `rho`, `rseed` and `alpha`;
- the output's `recipient`, `value` and `rseed`;
- `rcv`, `cv_net`, `cmx`, the encrypted note and the spend authorization signature;
- `bsk` and the global fields.

The IO Finalizer has already cleared the dummy spending keys (ZIP 374).

### Sealing

    sealed = tlock_age( age_x25519( frame ) )
    frame  = "CDS1" || LE64(len(c)) || c || 0x00^pad,     c = zstd(plaintext)

`seal(plaintext, runner_recipient, chain, r)` works as follows. [impl: `cadence-seal/src/seal.rs`]

1. Reject `len(plaintext) > MAX_PLAINTEXT_LEN` and `r = 0`. Reject a chain key that tlock cannot use, by tlock-encrypting a dummy 16-byte message first, because `tlock_age` would otherwise emit an unopenable stanza.
2. Compress the plaintext with zstd into a single frame, *c*.
3. Start both age encryptors before writing any payload:
   - the outer encryptor has one tlock stanza for (chain hash, chain public key, *r*);
   - the inner encryptor has one X25519 stanza for `runner_age_recipient`.

   Both write binary age. Measure each header-plus-nonce length; age adds a grease stanza of random length.
4. Pick the smallest bucket *B* in `BUCKETS` for which inverting the age STREAM length twice (64 KiB chunks, 16-byte tags) gives a frame length *F* ≥ 12 + len(*c*). Set *pad* = *F* − 12 − len(*c*).
5. Encrypt `frame` with the inner layer, then the result with the outer layer. The output MUST be exactly *B* bytes long; otherwise fail.

`open(sealed, identity, chain, beacon)` MUST do the following, in this order:

1. Read the outer header without any key: the round and the chain hash.
2. Require the chain hash to match.
3. Verify the beacon. It must be a BLS signature under the chain key on SHA-256(BE64(round)), hashed to G1 with DST `BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_` (RFC 9380 [^RFC9380]).
4. Decrypt the tlock layer inside a panic boundary.
5. Decrypt the age X25519 layer.
6. Parse the frame: check the magic, require `len` ≤ the remaining bytes, and require every padding byte to be zero.
7. Decompress with ruzstd. There must be exactly one frame, of at most `MAX_PLAINTEXT_LEN` bytes, with no trailing data.

The round and chain hash are readable in the clear. The recipient is not.

### Release round

    r_k = first_round_at_or_after(quicknet, release_at(k))
        = 1                                         if release_at(k) ≤ genesis
        = ⌈(release_at(k) − genesis) / 3⌉ + 1       otherwise
    time_of(r) = genesis + 3·(r − 1)

[impl: `drand.rs`]


## Subscription

The payer uploads `{ offer_id, pocket_id, installments: [ { k, release_round, sealed: base64 (standard, padded) } ] }`.

The Runner MUST check all of the following [impl: `api.rs::create_subscription`]:

- the offer and the pocket exist;
- the pocket backs no other subscription;
- the number of installments equals `count`;
- the installments are numbered `k` = 1…`count` in order;
- each Package's header round equals its `release_round`.

The Runner cannot inspect a Package's contents before its round. It records `amount_zat` from the Offer, not from the Package.

**Schedule check.** The Runner SHOULD also check the schedule against the Offer. This is the upload-time counterpart of release rule 2: it protects the merchant from a payer, and the payer's funds do not depend on it. [impl: `api.rs::check_schedule`, run before the header check]

- The Runner has recorded *F*, and value(*F*) ≥ `funding_total`.
- `time_of(r_1)` ≤ the upload time + `period_secs` + 600 s.
- For each *k* ≥ 2, `time_of(r_k)` − `time_of(r_{k−1})` is within `period_secs` ± ⌊`period_secs` / 2⌋. This implies that the rounds strictly increase.

Without it, a payer could seal a Ladder whose installments fall due a year apart, or from a Pocket that cannot cover them, and the Runner would accept it as the Offer. The tolerances leave room for signing time, for the payer's clock and for drand's 3 s rounding: with their default first release, both reference payers pass for every `period_secs` of 4 s or more. A failure is answered `400` with the reason. The sandbox's `stretch_schedule` probe runs this check on a copy of a real subscription's schedule with one installment moved a year later.


## Runner release rules

The Runner evaluates each subscription whose status is `active` or `stalled` at regular intervals (10 s by default). Before each evaluation it syncs its wallet to *tip*. Only the lowest-numbered installment that is not yet mined, called *k*, is considered.

1. **Open.** The Runner MUST NOT try to open Package *k* before `round_at(now) ≥ r_k`. It MUST fetch the beacon for round *r_k* and verify it before use (§ Sealing). It SHOULD fetch beacons over Tor. It then stores the beacon and moves *k* to `due`. [impl: beacons go over Tor unless `--drand-direct` is set. `--direct`, which `deploy/docker-compose.yml` sets for the Mainnet runner's own node, applies to lightwalletd only. The reference goes on to rules 2–8 in the same evaluation, rather than at the next one: waiting costs a block or more, and an installment mined after its target shows `expiry − mined` < δ.]

   The reference stores only the sealed Package and the public beacon at rest, and opens the Package again in memory on every attempt.
2. **Validate.** Before it broadcasts any rung of *k*, the Runner MUST check all of the following:
   - the Ladder's `k` is *k*;
   - every rung's PCZT is v6;
   - each rung's branch ID is branch(`target_height`), and its expiry equals both `expiry_height` and `target_height` + δ;
   - each rung has exactly one real Ironwood spend, whose nullifier is `spends_nullifier`;
   - one output pays the Offer's `amount_zat` to the Offer's Orchard receiver;
   - any other non-dummy output goes to the change receiver of the pocket UFVK;
   - the fee is the conventional fee.

   If a check fails, the Runner MUST NOT broadcast any rung of *k*.

   **[partial: `cadence-core/src/package.rs::verify_rung`, called from `cadence-runner/src/service.rs::release`.]** On every attempt, after opening the Package, the reference checks that the Ladder's `k` and `amount_zat` match the installment, whose amount comes from the Offer. Then, for the one rung it is about to broadcast (rule 5), it checks that:

   - the PCZT's branch ID is branch(*T*), its expiry is *T* + δ(*T*), and its lock time is 0;
   - it has no transparent, Sapling or Orchard-pool component;
   - some Ironwood output pays exactly `amount_zat` to the Offer's Orchard receiver, and the note rebuilt from that output's `recipient`, `value` and `rseed`, with ρ = the nullifier of the spend in the same action, has the output's `cmx`.

   It does not check the transaction version, the spend's nullifier, the other output or the fee, and it does not check that `enc_ciphertext` decrypts to the merchant's note (§ Security Considerations). A spend of any note other than the one named by `spends_nullifier` fails at rule 7, because the Runner installs that note's witness.

   A failed check marks *k* `invalid`, sets the subscription to `stalled` and sends `invoice.expired`. So does a Package that does not open, or whose Ladder JSON does not parse: once the beacon is verified, both failures are deterministic. A rung whose PCZT does not decode, or a `spends_nullifier` that does not decode, is instead an error that is retried at the next evaluation.
3. **Target.** The target is `T = tip + 1`. [impl: the reference reads the tip again just before choosing the rung, and syncs its wallet first if the chain has moved, because syncing, the beacon fetch and earlier subscriptions can take seconds over Tor.]
4. **Input.** Find the unspent Pocket note whose nullifier is `spends_nullifier`.
   - If there is none, and the input's mined height *m* is known and `tip ≥ m + 3`, apply the checks of § Cancellation, and if they pass, treat the Mandate as cancelled.
   - If there is none otherwise, wait.
   - If the note was mined above *T* − 3, wait.

   [impl]
5. **Exact rung, fail closed.** The Runner MUST select the rung whose `target_height` is *T*. If there is none:
   - if *T* is above the highest `target_height`, mark *k* `missed` (rule 10);
   - otherwise, wait. This covers a *T* below the window or inside a guard band.

   The Runner MUST NOT broadcast any other rung. [impl] Expiry and branch are signed, so the Runner cannot alter them.
6. **Anchor.** The anchor MUST be the root of the Ironwood note commitment tree as of the end of block *T* − 3. [impl]

   The reference takes the highest wallet checkpoint at or below *T* − 3, searching at most 100 blocks down, and the witness for *N_k* at that checkpoint. Before broadcasting it MUST confirm that this root equals the Ironwood root of `GetTreeState(T − 3)`. On a mismatch it MUST NOT broadcast and tries again at the next evaluation.

   In the reference Runner, `GetTreeState` goes to the same lightwalletd server it syncs from. That checks the wallet's tree against the server's node, but does not make the data independent of that server.
7. **Complete.** The Updater sets the Ironwood anchor and the witness on the action whose witness is absent. The Prover then proves with the Orchard-protocol `PostNu6_3` proving key, and the Transaction Extractor extracts the transaction, verifying proofs and signatures. On any failure the Runner MUST NOT broadcast. [impl: `wallet.rs::complete`]
8. **Broadcast.** The Runner SHOULD broadcast through a different lightwalletd connection, with separate Tor state, from the one it syncs with (`--broadcast-server`). It records the txid, *T* and `expiry_height`. [impl]

   A rung's v6 txid covers only effecting data, so it is fixed at signing time.
9. **Confirm and retry after expiry.**
   - If the transaction is mined, mark *k* `mined` and send `invoice.confirmed`.
   - If it is still unmined when `tip > expiry_height`, or when branch(tip + 1) differs from branch(*T*) because an upgrade has activated since *T*, move *k* back to `due` and apply rules 2 to 8 again with the new *T*, using the same Ladder. The new rung has byte-identical actions and the same nullifier, so the retry can never pay twice.

   [impl: `service.rs::confirm`, `branch_passed`] The expiry condition is conservative: a transaction is already dead once `tip ≥ expiry_height` (ZIP 203).
10. **Missed.** Mark *k* `missed`, set the subscription to `stalled` and send `invoice.expired`. [impl] In the reference no re-signing path exists (§ Re-signing), so *k* stays `missed`. The Runner still runs cancellation detection (§ Cancellation) for a `missed` or `invalid` installment, so a payer who cancels or sweeps ends the subscription as `cancelled`.
11. **Release-time jitter.** **[not impl]** A Runner MAY wait a random time after *r_k* before releasing. It can never release earlier.
12. **Finish.**
    - When every installment is mined, the subscription becomes `completed`.
    - On cancellation it becomes `cancelled`, and a merchant stop makes it `stopped`. In both cases the remaining installments become `cancelled`.

    Either way, the Runner MUST delete the Pocket's wallet account, the sealed Packages, the beacons and the pocket UFVK. [impl, at the file level: `service.rs::finish` deletes the wallet account, and `store.rs::shred` clears the sealed Packages, the beacons, the pocket UFVK and the raw funding transaction. Both SQLite databases run with `secure_delete`. After each shred, and when it is opened, the state database is rewritten with `VACUUM` and its WAL truncated; on opening, it also scrubs the pockets of subscriptions that had already finished. The wallet database is rewritten at each Runner start (`cadence-chain/src/wallet.rs::compact`). A copy-on-write filesystem or an SSD may still keep older blocks, so the Runner's disk should be encrypted. The public record stays: the funding txid, height and value, and each installment's state, txid and heights.]

    A Runner SHOULD also delete Pockets that never back a subscription. [impl: `service.rs::forget_abandoned` deletes the wallet account and the record of a Pocket that is still unfunded a day after registration, or funded but without a subscription a week after. The funds stay the payer's (§ Cancellation, `cadence sweep`).]

State transitions of an installment:

| From | To | When |
|---|---|---|
| `sealed` | `due` | the beacon for *r_k* is verified (rule 1) |
| `due` | `broadcast` | the rung for *T* is broadcast (rules 2–8) |
| `due` | `invalid` | the Package fails to open or parse, or a check of rule 2 fails |
| `due` | `missed` | *T* is above the highest rung (rule 10) |
| `broadcast` | `mined` | the transaction is mined (rule 9) |
| `broadcast` | `due` | the transaction is unmined and `tip > expiry_height`, or an upgrade has activated since *T* (rule 9) |
| `due`, `missed`, `invalid` | `mined` | an earlier broadcast of *k* is found mined while checking for cancellation (§ Cancellation) |
| any but `mined` | `cancelled` | cancellation is detected or the merchant stops (rule 12) |


## Cancellation

**Payer.** To cancel, the payer spends the live note. A cancellation stops Installment *k* only if it is mined before any rung of *k*. Once it is mined:

- every rung of *k* double-spends a nullifier that is already spent;
- the inputs of *k*+1 and later never come into existence, so those installments can never be proved.

The cancellation SHOULD have the installment shape (P2, P3): one spend, `ovk = None`, the default expiry and an anchor at *T* − 3, with fresh randomness rather than a rung seed.

The reference CLI's `cadence cancel` (`cadence-cli/src/subscribe.rs::cancel`) works as follows. Its requests to the Runner and to lightwalletd go over Tor, on isolated circuits of one arti client, unless `--direct` is given or the Runner is on a loopback address.

1. It reads the live note's nullifier, and the txid of the transaction that created it, from the Runner (`GET /api/pockets/{id}`).
2. It fetches that transaction from the payer's own lightwalletd and trial-decrypts it with the Pocket's external and internal IVKs (`mandate.rs::pocket_outputs`), keeping the note with that nullifier. The Runner can point at a note but cannot supply one.
3. It reads the target *T* and the witness from the Runner, and checks the anchor against the payer's own lightwalletd.
4. It pays value(live note) − fee(*T*) to an Orchard receiver the payer supplies, where fee(*T*) is the installment fee at *T* (§ Rung construction).
5. It proves locally and broadcasts through the payer's own lightwalletd.

The design does not require the Runner's cooperation, because the Pocket's notes and witnesses can be found by scanning with the pocket UFVK. The reference `cadence sweep --pocket <file> --to <UA> [--from <height>]` (`subscribe.rs::sweep`) does that scan, with no Runner involved. It imports the pocket UFVK into a fresh local wallet database with its birthday at `--from`, or at the funding height recorded in the file, and syncs from the payer's own lightwalletd (over Tor unless `--direct`). It then spends each anchor-deep note to the payer, for its value less the fee at tip + 1, as a 2-action transaction of the installment shape: Discard, fresh randomness, and an anchor at *T* − 3 checked against the same server. Notes less than 3 blocks deep are left for a later run. A sweep is how the payer recovers what stays in the Pocket after the Runner has deleted it (on completion, a merchant stop, or an abandoned Pocket). On a live subscription, a sweep is a cancellation.

**Runner detection.** [impl: `service.rs`]

- *Early.* Detection runs while *k* is `sealed`, `missed` or `invalid`, once the previous note is settled: *F* is mined, or *k*−1 is mined, at height *m*, and `tip ≥ m + 3`. If the Pocket then holds no unspent note, the Runner applies the checks below.
- *At release.* Rule 4.

Both detections see only that the input is gone. Before concluding that the payer spent it, the Runner MUST rule out the two other ways an input disappears: its own broadcast of *k* was mined, or a reorg removed the transaction that created the input. [impl: `service.rs::payer_cancelled`. If the Runner's last broadcast of *k* is mined, it records *k* as `mined` instead. Otherwise it requires the input's parent, the funding transaction for *k* = 1 and *k*−1's transaction otherwise, to still be mined.] When it does conclude cancellation, it applies rule 12 with status `cancelled` and sends `invoice.cancelled`.


## Re-signing at network upgrades and fee changes

**[not impl]** The reference implementation has no re-signing flow:

- `cadence resume` refuses to run once a subscription has been uploaded;
- the HTTP binding has no endpoint for replacing Packages;
- `missed` and `invalid` are terminal: the payer can only cancel or sweep.

This section specifies the requirement.

Re-signing is required in these cases:

- A network upgrade whose activation height was not known at signing time falls inside a Window. Rungs past it carry the old branch ID and are invalid.
- A change to the conventional fee that was not known at signing time falls inside a Window. ZIP 2009's Mainnet switch at 3,590,000 is known, so the reference signs each rung with the fee for its own height and needs no re-signing for it (§ Guard bands).
- An installment is `missed` or `invalid`.

To re-sign from Installment *j*, the payer builds new Ladders for every *k* ≥ *j* with attempt *a* + 1, using the current tip and time, and the current δ and fee. It seals them and uploads them. The Runner MUST then discard its old Packages for every *k* ≥ *j*.

Re-signing *k* changes *C(k)*. Every later installment must therefore be re-signed as well.

Old and new rungs of the same *k* share an input nullifier, so at most one of them can be mined. A Runner that kept an old Package can release at most the old schedule; it gains no extra value.

A lower fee leaves a positive change after Installment `count`, which the payer recovers as described under Cancellation. Re-signing requires the payer to come back online, once per unscheduled upgrade or fee change.


## HTTP binding

The binding is informative. `docs/api.md` is the informative appendix. Every body is JSON, every amount is in zatoshis, and every round is a quicknet round.

| Method and path | Caller | Authentication | Purpose |
|---|---|---|---|
| `POST /api/offers` | merchant | bearer token | create an Offer; returns `share_url = {app_url or public_url}/subscribe#offer=<base64url(offer)>` |
| `GET /api/offers/{id}` | payer | none | the Offer (§ Offer) |
| `POST /api/pockets` | payer | none | register a pocket UFVK; birthday = tip + 1 |
| `GET /api/pockets/{id}` | payer | none (the id is a capability) | funding `{txid, tx_hex, mined_height, value_zat}`, unspent notes |
| `GET /api/pockets/{id}/witness?nullifier=` | payer | none | `{target_height, anchor_height, anchor, position, auth_path[32]}` for a cancellation |
| `POST /api/broadcast` | payer (browser) | none | relay a raw transaction |
| `POST /api/subscriptions` | payer | none | upload Packages (§ Subscription) |
| `GET /api/subscriptions` | merchant | bearer token | list subscriptions |
| `GET /api/subscriptions/{id}` | anyone who knows the id | none | one subscription and its installments |
| `POST /api/subscriptions/{id}/stop` | merchant | bearer token | stop and shred (rule 12) |
| `GET /api/decode/{txid}` | anyone | none | public transaction shape |
| `GET /api/status` | anyone | none; the subscription count needs the bearer token, except on a sandbox | network, tip and current round |
| `POST /api/sandbox/offer`, `POST /api/sandbox/fund`, `POST /api/sandbox/cheat` | anyone, Testnet sandbox only | none | a demo Offer paying the sandbox wallet; fund a pocket from that custodial wallet; the Runner's attempted violations |

A Runner started with `--app-url` or `--cors-origin` answers `/api/*` requests from exactly those origins (CORS, without credentials), so a payer app can be served from an origin the merchant does not control.

Webhooks are sent as `POST`s. Each carries `X-Cadence-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`, and, with the same secret, `X-CipherPay-Signature: <hex HMAC-SHA256(secret, "<X-CipherPay-Timestamp>.<body>")>`, `X-CipherPay-Timestamp` (UTC ISO 8601) and `X-CipherPay-Delivery-Id` (a v4 UUID), computed as CipherPay computes them. The body is `{type, event, delivery_id, offer_id, subscription_id, k, txid|null, amount_zat, mined_height|null}`. The event types are `invoice.confirmed`, `invoice.expired` and `invoice.cancelled`; `event` carries CipherPay's names for them (`confirmed`, `expired`, `subscription.canceled`). The body is otherwise not CipherPay's: it has no `invoice_id`. The reference makes at most 3 attempts from memory, with no persistent outbox, so the Runner's subscription state is the durable record.


# Rationale

## Lineage

On transparent chains the shape is not new. A March 2026 Bitcoin Cash design pre-signs a chain of `nLockTime`-dated transactions, each spending the previous change: the receiver broadcasts each when due, and the payer cancels by spending the change [^bch-recurring]. A shielded transaction has no transparent inputs, so `nLockTime` cannot date it, and every amount and address on BCH is public. This ZIP takes "not before" from drand instead.

ZIP 318 [^zip-0318] and librustzcash's `zcash_pool_migration` [^pool-migration] already pre-sign height-scheduled v6 transfers as PCZTs with deferred anchors. The user's own wallet stores them and broadcasts them later. `DeferredPcztBuilder` [^zcash-primitives] provides the signing-before-witness primitive. This ZIP adopts both and changes four things.

| | ZIP 318 / `zcash_pool_migration` | This ZIP |
|---|---|---|
| Executor | the user's wallet, in a background task | a third party (the merchant's Runner) with no spend authority |
| Not before | the wallet's own scheduler (a trusted device) | the drand round *r_k*, through tlock |
| Not after | a canonical expiry: a multiple of 34,560 + 2 × 34,560 blocks, one signature per transaction | the v6 expiry of a per-height rung, *T* + δ(*T*) |
| Anchor | a shared boundary every 144 reference blocks, drawn with a recency weighting | *T* − 3, chosen fresh at release |
| Revocation | the wallet does not broadcast | self-spend of the live note, enforced by consensus |
| Funding | denomination preparation transactions | one funding payment, then chained change notes |

## Third-party executor without spend authority

Under ZIP 374, the Prover of an Orchard-protocol spend needs the spend's `fvk`, note data, witness and `alpha`, but no spending key. The Runner therefore gets exactly the Prover's inputs. The Signer role, which holds *ask_P*, stays with the payer and finishes at subscription time.

v6 makes anchors authorizing data. The spend authorization signature and the binding signature cover every effecting field: outputs, values, memos inside `enc_ciphertext`, the fee, the expiry and the branch. So a Runner can change only the anchor and the proof.

## drand for "not before"

Nothing in an Ironwood-only v6 transaction gives it a lower height bound. `nLockTime` is enforced only when some transparent input is non-final, under the `IsFinalTx` rule Zcash inherits from Bitcoin, so it cannot constrain a transaction with no transparent inputs. A non-zero `lock_time` would also be a fingerprint: 100% of the mainnet class has `lock_time = 0`. Once the input note exists, a rung can be mined at any height up to its expiry.

The party that must be stopped from releasing early is the one holding the Package. A time-lock that the holder cannot open is therefore the mechanism. tlock with drand quicknet [^tlock] provides it under a threshold assumption. Sealing needs only the chain's public key, so the payer never contacts drand.

age is the inner layer, so a tlock failure exposes Packages only to the Runner.

## v6 expiry for "not after"

The v6 sighash commits to the header, including `nExpiryHeight` and the consensus branch (ZIP 229, which computes digests as in ZIP 244 [^zip-0244] with the anchors moved to authorizing data). Expiry gives a consensus-enforced upper bound: Installment *k* can never be mined above max(`target_height`) + δ.

ZIP 318 signs each transaction once with a long canonical expiry. That shape suits a coordinated migration population. Here it would produce `expiry − mined` values far above δ, which ordinary sends never show (P2). Signing one rung per height, and broadcasting only the rung for exactly tip + 1, makes `expiry − target` = δ, as in a stock send.

## Self-spend cancellation

A signed transaction can be revoked only by making its input unspendable. Spending the live note does that, consensus enforces it, and the Runner's cooperation is not needed. The cancellation costs one fee and looks like an installment (`evidence/E2E-service-testnet.md`, run 2).

## Other choices

- **Chained change notes instead of pre-split notes.** One funding payment, no preparation transactions, and 2 actions per installment. The cost is that *k*+1 cannot be released until *C(k)* is anchor-deep.
- **Anchor at *T* − 3.** ZIP 315 [^zip-0315] recommends a fixed anchor depth equal to the trusted confirmation depth, which it sets at 3. In the mainnet sample, 78% of the class is consistent with this rule. *F* comes from outside the Pocket, so ZIP 315 would call it untrusted and require 10 confirmations; this ZIP uses 3. That is a *Choice*. A reorg of *F* can only delay Installment 1.
- **Discard.** The pocket UFVK includes the Pocket's OVKs. If change and cancellation outputs used them, the Runner could decrypt where cancelled funds went. With Discard, `out_ciphertext` is undecryptable, just as stock outgoing ciphertexts are to anyone without the sender's OVK.
- **Fresh seed and a non-zero account.** A Pocket shares no key material with the main wallet. The non-zero account is defense in depth: if *S* were ever imported into a stock wallet, that wallet would restore account 0, find nothing, and so never sweep the Pocket with the default OVK, which the Runner could decrypt.
- **Keyed PRF seed.** P1 needs a single seed per installment. The payer has to be able to recompute *C(k)* from *S*. Nobody else may be able to compute the seed, because it determines `esk` and `rcv`, and with those anyone could decrypt the outputs and open the value commitments. `mandate_id` is not secret (the wasm signer puts it in the memo), so the seed must be keyed.
- **Bucket padding.** The size of a Package reveals only its bucket. Identical actions across rungs compress well under zstd: each Package in the testnet run, with 157 to 175 rungs, fit the 64 KiB bucket.


# Privacy Implications

## Chain observer

Each installment is v6 and Ironwood-only, with 2 actions, `flags = 7`, `lock_time = 0`, the installment fee at *T* (10,000 zatoshis, or 2,000 on Mainnet from 3,590,000), a 7,264-byte proof, expiry *T* + δ and an anchor at *T* − 3. On testnet every installment and the cancellation decode with 0 outputs recoverable under the all-zero OVK and 0 under the Pocket's OVKs (`evidence/S2-testnet.md`, `evidence/E2E-service-testnet.md`).

The mainnet sample covers 200 blocks, heights 3,526,581 to 3,526,780 (`evidence/fingerprint-mainnet-sample.json`):

- Cadence's class ("V6, Ironwood-only, 2 Ironwood actions") accounts for 168 of 521 Orchard-family transactions. It is the largest decoded class.
- Within the class, the following are identical across 100% of members:
  - the fee (10,000);
  - the flags (7);
  - `lock_time` (0);
  - the proof size (7,264 bytes);
  - the zero-OVK result (0 recoverable);
  - the version (V6);
  - the branch (`37a5165b`).
- `expiry − mined` is 40 for 46% of the class and 39 for 30%.
- Inferring each member's target as expiry − 40, 125 of the 160 members with an inferable offset are consistent with an anchor at target − 3. The shares are not exclusive, because the root does not change across blocks with no Ironwood commitments.

The sample predates NU7, where δ = 40. No Cadence transaction has yet been mined on mainnet, and the post-NU7 population (δ = 120) has not been measured.

## What the Runner learns

The Runner holds the Pocket's Orchard FVK and, after each round, that installment's redacted PCZTs. It learns:

- the Pocket's notes and their values;
- the funding txid, and the memo of the funding note, if the payer's wallet set one;
- the schedule, the amounts and the change values;
- every Pocket nullifier, so it sees when and in which transaction the live note is spent;
- the full contents of each installment, as ZIP 374 warns.

From a cancellation it learns:

- that the payer cancelled, and when;
- the refund amount, by arithmetic: the reference cancellation pays value(live note) − fee(*T*).

It does not learn:

- where the refund went, because of Discard;
- anything about the main wallet beyond what the public funding transaction shows;
- the payer's other Mandates, which use other Pockets;
- *S*, `app_secret` or *σ*;
- any Package's contents before its round.

The Runner chooses the anchor and the broadcast time. A malicious Runner can make installments stand out, for instance with a stale anchor or an inexact rung. That harms the payer's privacy, not their funds, and the payer cannot detect it before broadcast.

## The stale-anchor argument

Delegating proving is what costs the FVK. The alternatives are worse:

- **Prove at signing time.** This is impossible for *k* ≥ 2 with chained change, because the witness for *C(k−1)* does not exist yet.
- **Pre-split the funding into `count` notes and prove up front.** Each installment would then carry an anchor as old as the split: months, for a monthly Mandate. In the mainnet sample, only 1 of 168 members of the class has an anchor deeper than 21 blocks.
- **The payer re-proves online.** That defeats Requirement 1.

## Timing residual

- **Periodic release.** The Runner releases at the first evaluation after three conditions hold: *r_k* has passed, *N_k* is anchor-deep, and a rung exists. Installments therefore form a series with period `period_secs`, plus block granularity. The only defense is the size of the class: about 0.84 per block in the pre-NU7 sample. Release-time jitter is **not yet implemented**, and the threat model says so.
- **Funding proximity.** With the CLI default `--first-in 60`, Installment 1 is mined within a few blocks of the funding transaction. That is a timing correlation, though not a cryptographic link.
- **Late release.** An installment mined after its target shows `expiry − mined` < δ. The public testnet sandbox run (`evidence/railway-sandbox.md`) mined two installments 5 and 11 blocks late, because the reference released one evaluation after opening, against a stale tip; it now releases in the same evaluation, against a fresh tip (rules 1 and 3). The fix has not yet been measured on a public run.
- **Expiry retries.** A retry spends the same nullifier, which is inherent to spending the same note, so a mempool observer can link the two broadcasts. The `attempt` input of the seed would not prevent this.
- **Chaining.** Installment *k*+1 cannot be mined until *C(k)* is anchor-deep, which matters only for short periods.

## Network and infrastructure

- **Payer to Runner.** The reference CLI reaches the Runner over Tor, through its embedded arti client, on circuits isolated from its lightwalletd traffic (`cadence-cli/src/http.rs`). The exceptions are a Runner on a loopback address, which Tor cannot reach, and `--direct`. The CLI's chain access goes over Tor too. The web build is disclosed as clearnet unless it is used through Tor Browser; whatever terminates TLS in front of the Runner or the app host sees client IP addresses and request paths.
- **Who serves the payer app.** A browser payer runs whatever code its web host serves, including the code that holds *S*. When the Runner serves the app, the merchant could serve code that exfiltrates *S*, which no rule of this ZIP prevents. The reference web app can instead be built for a host of its own (`VITE_API=runners`), which publishes the commit and a SHA-256 of every served file (`build.json`) so that payers can compare it with a build they trust; the CLI avoids the question.
- **drand relays.** The reference Runner fetches beacons over Tor unless `--drand-direct` is set (see rule 1). Package headers reveal *r_k* to anyone who stores them.
- **Capabilities in the HTTP binding.** `GET /api/pockets/{id}` and `GET /api/subscriptions/{id}` are unauthenticated. Their 80-bit random ids act as bearer capabilities that expose funding data, notes, the schedule and txids. The subscription list, and the count in `GET /api/status`, need the merchant's token, except on a Testnet sandbox.
- **Decoding.** `GET /api/decode/{txid}` fetches the transaction and up to 12 tree states through the Runner's sync connection, so that lightwalletd server learns which txids are decoded, from the Runner rather than the visitor.


# Security Considerations

- **Spend authority.** The Runner never holds *ask_P*. Amounts, recipients, the fee, the expiry and the branch are under the spend authorization and binding signatures. Every rung of *k* spends the same nullifier, so at most one installment *k* is ever mined. A rebroadcast of a mined installment, or a replay after a cancellation, is a double-spend.
- **drand threshold.** "Not before" assumes that fewer than a threshold of the League of Entropy's quicknet nodes collude, and that the BLS12-381 assumptions hold.

  If that assumption fails, the Runner, and only the Runner, can open every Package at once. Consensus requires only that an installment's input be mined in an earlier block, so the Runner can then release each remaining installment as soon as the previous one is mined: one block later at the earliest, or about 3 blocks if it keeps the anchor rule. An installment released before its Window can only use an inexact rung, which leaves a visible `expiry − mined > δ`.

  The amounts and the recipient are unchanged, so the loss is at most early payment of the whole prefunded Mandate: at most `count` ≤ 12 installments. Rolling funding (fewer periods per Pocket) is not implemented; the whole Mandate is prefunded, and a payer who wants a smaller exposure subscribes for fewer periods.

  If drand halts, Packages stay locked, installments are missed, and the funds stay in the Pocket under the payer's control.
- **`tlock_age` 0.0.10 is unaudited.** Its decryption panics (`assert_eq!` in `ibe::decrypt`) when the signature is wrong or the stanza is inconsistent. Anyone who knows the Runner's recipient can craft such a stanza. `cadence-seal` hardens against this in three ways:
  - it verifies the beacon before decrypting;
  - it runs tlock decryption under `catch_unwind` and maps a panic to `MalformedTimeLock`;
  - it pre-checks chain keys when sealing.

  The panic boundary requires `panic = "unwind"`. The workspace sets no panic profile, so the default applies; under `abort`, a crafted Package would kill the process. Confidentiality against third parties rests on age X25519 alone.
- **Runner identity compromise.** Someone who obtains both the Runner's age identity and its stored Packages can read each Ladder after its round. They learn the pocket FVK and can broadcast installments, which still pay the merchant.
- **Runner liveness.** If the Runner is down for a whole Window, the installment is missed and the funds stay with the payer. In the reference implementation `missed` is terminal (§ Re-signing).
- **FVK non-revocability.** A viewing key cannot be revoked. The exposure is bounded by single-use Pockets: the FVK reveals only this Pocket, which is empty after an exactly funded Mandate completes. Pocket addresses MUST NOT be reused.

  A malicious Runner can keep copies of everything. An honest one MUST delete the UFVK (rule 12); the reference does, from both databases, at the file level.
- **Merchant-side validation.** The schedule check (§ Subscription) stops a payer from uploading a schedule that does not follow the Offer, such as one installment a year late. Rule 2 stops a payer from sealing a Ladder that pays someone else or less: the reference Runner broadcasts only a rung with an output paying exactly `amount_zat` to the Offer's Orchard receiver, whose note commitment it rebuilds. It does not check that the output's `enc_ciphertext` decrypts for the merchant. A payer who corrupts the ciphertext still pays the note, so this costs the payer the installment, but the merchant's wallet does not see it, while the Runner sends `invoice.confirmed`. A merchant that needs proof of receipt SHOULD check its own wallet.
- **Misclassification and reorgs.** Before taking "input spent" to mean "payer cancelled", the reference checks that its last broadcast of *k* is not mined and that the input's parent still is (§ Cancellation). It does not otherwise handle reorgs: an installment is marked `mined` the first time it is seen, and that record is never revisited, so a reorg that later drops it is not reflected in the Runner's state or webhooks.
- **Trusted JSON fields.** The Runner selects rungs by the payer-declared `target_height` and schedules retries by `expiry_height`, without checking either against the PCZT. A lying payer affects only its own privacy and liveness.
- **Hostile Packages.** A Package is bounded in several ways:
  - decompression is capped at 64 MiB, with a single zstd frame and no trailing data, using the pure-Rust ruzstd decoder;
  - frame padding must be zero;
  - the HTTP body limit is 80 MiB.

  A Package that fails to open, or whose Ladder does not parse, marks its installment `invalid` and sends `invoice.expired` (rule 2): once the beacon is verified, both failures are deterministic. A Package that opens but fails to prove is retried until its rungs run out.
- **Builder determinism.** P1 depends on the exact builder version (§ Builder randomness). An upgrade between signing and cancellation can make the payer's recomputed *C(k)* wrong. The reference CLI would then refuse to cancel ("a note this pocket never created") until the right version is used.
- **Payer key custody.** *S* is the only spend authority. If *S* is stolen, the thief can sweep the Pocket; that includes a web host that serves the payer code which leaks it (§ Privacy Implications, *Who serves the payer app*). If *S* is lost, the payer can no longer cancel, nor recover what is left after a stop, a missed installment or overfunding, and the Mandate runs to completion as signed. The reference web app has the payer reopen the saved kit before it calls the tab closeable (§ Pocket).


# Deployment

This ZIP needs no consensus change. It requires:

- NU6.3 or later, for v6 transactions and the Ironwood pool;
- PCZT v2 with deferred anchors (ZIP 374);
- a lightwalletd that serves Ironwood tree states;
- drand quicknet.

Status as of 2026-10-27:

- On NU7 testnet, a view-only Runner has released three chained installments (`evidence/S2-testnet.md`).
- The full service has run on NU7 testnet: subscribe, release, completion, cancellation, and a run with everything over Tor (`evidence/E2E-service-testnet.md`).
- A public sandbox Runner on Railway has released three installments signed in a browser by the WASM signer, and refused early-opening and tampering attempts (`evidence/railway-sandbox.md`).
- On Mainnet, two Mandates were funded from Zodl and signed in a browser: a three-installment run whose installments each mined in their target block, and a weekly Mandate whose third installment, already signed, will be the first after NU7 (`evidence/mainnet.md`).

**NU7.** Windows may straddle activation, because each rung is signed with the branch for its own target height. The S1 test checks identical actions on both sides. A pre-NU7 rung that is broadcast but not mined by height 3,543,404 is dead at activation. A Runner SHOULD treat such a rung as expired at activation rather than waiting for its expiry, which for the last pre-NU7 rung (target 3,543,394, expiry 3,543,434) is 30 blocks, about 12.5 minutes, later. [impl: `service.rs::branch_passed` moves it back to `due` as soon as branch(tip + 1) differs from branch(*T*).]

**ZIP 2009 on Mainnet.** Each rung pays the fee for its own target height, and no Window straddles height 3,590,000 (§ Guard bands), so a Mandate that runs past the switch needs no re-signing: a monthly Mandate signed on Mainnet today has a Window for every installment (`mandate.rs` test `mainnet_windows_keep_to_one_side_of_the_fee_switch`). Each installment after the switch leaves 8,000 zatoshis in the Pocket for the payer to recover.

ZIP 2009 expects height 3,590,000 in mid-December 2026. Under ZIP 218's 25 s spacing, the code's model puts it about 13.5 days after NU7 activation (46,595 blocks). The rule depends only on the height, not on the date.

**Future upgrades.** Rungs past an activation that was not scheduled at signing time carry the old branch, and nodes reject them. A Runner SHOULD check that branch(*T*) matches the rung's branch before proving, to avoid wasted proofs. [impl: `verify_rung` refuses such a rung, so the installment becomes `invalid`.] The Mandate then needs re-signing.


# Reference Implementation

<https://github.com/OoJae/cadence> (MIT OR Apache-2.0). It pins `zcash_primitives` =0.31.0, `pczt` =0.10.0, `orchard` =0.16.0, `zcash_protocol` =0.11.0, `zcash_keys` =0.17.0, `zcash_client_backend` =0.25.0, `zcash_client_sqlite` =0.23.0, `tlock_age` =0.0.10 and `age` 0.11.

| Component | Path |
|---|---|
| Pocket, rung, randomness, schedule and window, redaction | `crates/cadence-core/src/{pocket,rung,seed,mandate,package}.rs` |
| Sealing, drand | `crates/cadence-seal/src/{lib,seal,drand}.rs` |
| Wallet: import, anchor and witness, check, complete | `crates/cadence-chain/src/wallet.rs` |
| Runner: release rules, HTTP binding and schedule check, webhooks, Testnet sandbox | `crates/cadence-runner/src/{service,api,store,webhook,sandbox}.rs` |
| Payer CLI: subscribe, resume, cancel, sweep; Runner HTTP over Tor | `crates/cadence-cli/src/{main,subscribe,http}.rs` |
| Browser signer | `crates/cadence-wasm` |
| Shape decoder and fingerprint scanner | `crates/cadence-decode` |
| Tests | `cargo test -p cadence-core` (S1 determinism), `cargo test -p cadence-seal`, `cargo test -p cadence-runner` (schedule check, CORS, webhooks) |
| Evidence | `evidence/S2-testnet.md`, `evidence/E2E-service-testnet.md`, `evidence/railway-sandbox.md`, `evidence/fingerprint-mainnet-sample.json` |

Known differences between this draft and the reference implementation, also marked inline:

| Item | Status |
|---|---|
| Checking the uploaded schedule against the Offer (§ Subscription, next to rule 2) | impl: funding, first release within `period_secs` + 600 s, gaps within `period_secs` ± ⌊`period_secs` / 2⌋ |
| Validating the Ladder against the Offer before broadcast (rule 2) | partial: index, amount, recipient and note commitment, branch, expiry, lock time and pools; not the version, spend nullifier, other output or fee |
| Release-time jitter (rule 11) | not impl |
| Re-signing flow, and recovery from `missed` or `invalid` | not impl: the payer cancels or sweeps and subscribes again |
| Deleting the pocket UFVK and funding transaction at finish (rule 12) | impl, at the file level |
| Confirming that the spender is not the installment itself before declaring cancellation | impl |
| Cancellation after the Runner deletes the Pocket account | impl: `cadence sweep` |
| Runner traffic from the CLI over Tor | impl, except to a loopback Runner |
| drand over Tor in the Mainnet compose file | impl (`--direct` applies to lightwalletd only) |
| Memo conforming to ZIP 302 | impl (§ Memo) |
| Rolling funding | not impl |

`docs/api.md` matches the code as of this draft.


# References

[^BCP14]: [Information on BCP 14 — "RFC 2119: Key words for use in RFCs to Indicate Requirement Levels" and "RFC 8174: Ambiguity of Uppercase vs Lowercase in RFC 2119 Key Words"](https://www.rfc-editor.org/info/bcp14)

[^zip-0032]: [ZIP 32: Shielded Hierarchical Deterministic Wallets](https://zips.z.cash/zip-0032)

[^zip-0203]: [ZIP 203: Transaction Expiry](https://zips.z.cash/zip-0203)

[^zip-0218]: [ZIP 218: 25-second Block Target Spacing](https://zips.z.cash/zip-0218)

[^zip-0229]: [ZIP 229: Version 6 Transaction Format](https://zips.z.cash/zip-0229)

[^zip-0244]: [ZIP 244: Transaction Identifier Non-Malleability](https://zips.z.cash/zip-0244)

[^zip-0259]: [ZIP 259: Deployment of the NU7 Network Upgrade](https://zips.z.cash/zip-0259)

[^zip-0302]: [ZIP 302: Standardized Memo Field Format](https://zips.z.cash/zip-0302)

[^zip-0315]: [ZIP 315: Best Practices for Wallet Implementations](https://zips.z.cash/zip-0315)

[^zip-0316]: [ZIP 316: Unified Addresses and Unified Viewing Keys](https://zips.z.cash/zip-0316)

[^zip-0317]: [ZIP 317: Proportional Transfer Fee Mechanism](https://zips.z.cash/zip-0317)

[^zip-0318]: [ZIP 318: Orchard to Ironwood Migration](https://zips.z.cash/zip-0318)

[^zip-0321]: [ZIP 321: Payment Request URIs](https://zips.z.cash/zip-0321)

[^zip-0374]: [ZIP 374: Partially Created Zcash Transaction Format](https://zips.z.cash/zip-0374)

[^zip-2005]: [ZIP 2005: Ironwood Quantum Recoverability](https://zips.z.cash/zip-2005)

[^zip-2009]: [ZIP 2009: Reduce Marginal Fee to 1000 Zatoshis and Raise the Weight Ratio Cap to 10](https://zips.z.cash/zip-2009) (Draft)

[^bch-recurring]: [Recurring Payments on Bitcoin Cash: Two Working Approaches (No Covenants, No OP_RETURN)](https://bitcoincashresearch.org/t/recurring-payments-on-bitcoin-cash-two-working-approaches-no-covenants-no-op-return/1774), 2026-03-18

[^pool-migration]: [`zcash_pool_migration` 0.2.0 (librustzcash)](https://crates.io/crates/zcash_pool_migration)

[^zcash-primitives]: [`zcash_primitives` 0.31.0, `transaction::builder::DeferredPcztBuilder`](https://docs.rs/zcash_primitives/0.31.0)

[^tlock]: [Gailly, Melissaris, Romailler, "tlock: Practical Timelock Encryption from Threshold BLS", IACR ePrint 2023/189](https://eprint.iacr.org/2023/189); [drand quicknet](https://drand.love); [age v1](https://age-encryption.org/v1)

[^RFC9380]: [RFC 9380: Hashing to Elliptic Curves](https://www.rfc-editor.org/rfc/rfc9380)
