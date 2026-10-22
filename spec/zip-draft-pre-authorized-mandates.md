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

Every installment is an ordinary v6 Ironwood transaction: 2 actions, the ZIP 317 fee, the default expiry and an anchor three blocks back.


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
| Installment fee `fee_inst` | 10,000 zatoshis = 2 × `MARGINAL_FEE` (5,000) | `mandate.rs::installment_fee`; ZIP 317 [^zip-0317] |
| Offer `count` range | 1 ≤ `count` ≤ 12 (Runner policy) | `cadence-runner/src/api.rs` |
| PRF personalizations | `"Cadence_AppSecrt"`, `"Cadence_RungSeed"` (16 bytes each) | `cadence-core/src/seed.rs` |
| Frame magic | `"CDS1"` | `cadence-seal/src/seal.rs` |
| `BUCKETS` | 65,536 × 2^*n* bytes, *n* = 0…9 (64 KiB to 32 MiB) | `seal.rs` |
| `MAX_PLAINTEXT_LEN` | 67,108,864 bytes (64 MiB) | `seal.rs` |
| zstd level | 10 with C zstd (`zstd-native`); ruzstd `Fastest` otherwise (wasm32) | `seal.rs` |
| drand chain | quicknet, `bls-unchained-g1-rfc9380`; hash `52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971`; genesis 1,692,803,367; period 3 s | `cadence-seal/src/drand.rs` |
| Runner evaluation interval | 10 s (default `--tick`) | `cadence-runner/src/main.rs` |
| Checkpoint search depth | 100 blocks | `wallet.rs::anchor_and_witness` |


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

*S* is raw entropy, not a BIP 39 mnemonic, so no stock wallet can restore a Pocket. Payer software MUST retain *S* for the life of the Mandate, because cancellation needs *ask_P*. The reference CLI keeps *S* in the subscription file, unencrypted in the development build.


## Offer

The Runner publishes an Offer. The payer fetches it (`GET /api/offers/{id}`) and signs against it.

| Field | Type | Meaning | Where it ends up |
|---|---|---|---|
| `offer_id` | `"off_"` + 20 hex digits | Runner identifier | subscription upload |
| `name` | string | display only | nowhere |
| `amount_zat` | u64 > 0 | amount of each installment | value of the merchant output (signed) |
| `period_secs` | u64 > 0 | spacing between release times | `release_at(k)` |
| `count` | u32, 1 to 12 | number of installments | Ladders; `funding_total` |
| `merchant_ua` | Unified Address with an Orchard receiver | payee | recipient of the merchant output: its Orchard receiver (signed) |
| `runner_age_recipient` | age X25519 recipient (`age1…`) | inner sealing layer | Packages |
| `runner_endpoint` | URL | where the payer reaches the Runner | nowhere |
| `network` | `"main"` or `"test"` | consensus parameters | everything |
| `drand_chain` | hex chain hash | outer sealing layer | Packages. Both reference payers ignore this field and always seal to quicknet. |

The payer chooses these values, which are not part of the Offer:

- `first_release_at`, a unix time. The reference CLI sets it to the signing time plus `--first-in`, which defaults to 60 s.
- `mandate_id`, 16 random bytes.
- `tag`, 16 bytes (§ Memo).
- *S*.

Release times are `release_at(k) = first_release_at + (k − 1) · period_secs`.


## Funding

    fee_inst      = 10,000 zatoshis
    funding_total = count · (amount_zat + fee_inst)

The payer funds the funding address with one payment of `funding_total` from an Ironwood balance. Payer software SHOULD present that payment as a ZIP 321 [^zip-0321] URI, `zcash:<funding address>?amount=<decimal ZEC>`. [impl]

The Runner records as the funding note *F* the earliest-mined unspent Pocket note. The payer decrypts *F* from the raw funding transaction using the external IVK and requires its recipient to be the funding receiver. Payer software MUST refuse to sign if value(*F*) < `funding_total`. [impl]

If value(*F*) > `funding_total`, Installment `count` has a non-zero change note, which stays in the Pocket. See § Cancellation for how that residue is recovered.


## Installments and rungs

Installment *k* consists of (*N_k*, `amount_zat`, the merchant's Orchard receiver, *memo_k*).

### Rung construction

Given network parameters, a target height *T*, the Pocket, Installment *k* and a seed *σ_k*, a rung is built as follows. This is the reference `cadence-core/src/rung.rs::build_rung`.

1. Create a `DeferredPcztBuilder` for *T*, with `BundlePadding::DEFAULT` for both the Orchard and Ironwood pools. The transaction version is the one suggested for branch(*T*), and it MUST be v6; the builder refuses earlier formats. The expiry height MUST be *T* + δ(*T*). The builder's default is used, with no override.
2. Add one Ironwood spend of *N_k* with *fvk_P*, without a witness. *N_k* MUST be a note of version V3, the Ironwood note plaintext format whose lead byte is `0x03` (ZIP 2005).
3. Add the merchant output: recipient = the merchant's Orchard receiver, value = `amount_zat`, memo = *memo_k*, `ovk = None`.
4. Compute `fee` with the ZIP 317 standard fee rule over the builder's action count, padding included. That count is always 2, so `fee` = 10,000.
5. Compute `change = value(N_k) − amount_zat − fee`. It MUST be ≥ 0. If `change > 0`, add an output to the change receiver with value `change`, the empty memo (`0xF6` followed by 511 zero bytes) and `ovk = None`.
6. Build the PCZT parts with `ChaCha20Rng::from_seed(σ_k)` (rand 0.10). The anchor and witness stay absent.
7. Run the Creator, the IO Finalizer and the Signer. The Signer signs the real spend with *ask_P* over the v6 shielded sighash. The reference takes the randomness for the IO Finalizer and for the signatures from the system RNG. Signatures are authorizing data and differ between rungs anyway.
8. Record the index of the spend action and *C(k)*: output index 1, if present. *C(k)* is rebuilt as Note(recipient, value, ρ = the nullifier of the spend in the same action, rseed, V3), and its `cmx` MUST match.

Every rung MUST have these properties:

- **P1 (rung invariance).** For a fixed Installment *k* and seed *σ_k*, the Ironwood actions MUST be byte-identical for every *T* in *W_k*. This covers `cv_net`, `nf`, `rk`, `cmx`, `epk`, `enc_ciphertext` and `out_ciphertext`, and the order of the actions. It holds across a network upgrade too. Only the expiry height, the branch ID, the sighash and the signatures may differ. *C(k)* therefore does not depend on which rung of *k* is mined, and that is what lets *k*+1 be signed in advance. [impl: S1 test, `crates/cadence-core/tests/s1_determinism.rs`, which covers Mainnet heights 3,530,000 and 3,530,001 (NU6.3) and 3,543,405 (NU7)]
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

P1 also depends on how the builder consumes the RNG output, and that is implementation-defined. The reference uses `zcash_primitives` 0.31.0 and `orchard` 0.16.0. All rungs of an Installment MUST therefore be produced by the same builder implementation. Payer software that later recomputes *C(k)* MUST either use that same implementation or keep a copy of *C(k)*; the reference CLI recomputes *C(k)* when it cancels.

### Memo

    memo_k = tag || LE32(k)        -- 20 bytes, zero-padded to 512

[impl: `mandate.rs::presign`]

The tag differs between the reference payers:

- `cadence subscribe` uses a random 16-byte tag.
- The wasm signer defaults the tag to `mandate_id`.
- The development `cadence presign` command uses `mandate_id`.

The Runner never reads the memo, and the HTTP binding does not tell the merchant the tag.

**Conflict with ZIP 302 [^zip-0302].** If the first byte of a memo is ≤ `0xF4`, a reader MUST decode the memo as UTF-8 and report an error if that fails. A random tag has a first byte ≤ `0xF4` with probability 245/256, and it is almost never valid UTF-8. A future revision should prefix `0xFF` ("no particular interpretation").

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
        W_k    ← { h ∈ [start, p + above] : h ∉ Excluded }

Presigning MUST fail with `EmptyWindow(k)` if *W_k* is empty. [impl: `mandate.rs::window`] *Choice:* the constants 10, 150, 4, 100 and 50 are tuning parameters.

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

In the testnet end-to-end run (`evidence/E2E-service-testnet.md`), offsets of 60 s, 180 s and 300 s produced the 157, 167 and 175 rungs this formula predicts.

### Guard bands

`Excluded` is empty on Testnet. On Mainnet it is:

    Excluded = { h : 3,543,395 ≤ h ≤ 3,543,404 }    -- [A − 10, A)
             ∪ { h : h ≥ 3,590,000 }                 -- the ZIP 2009 fee switch

Both bands are *Choices*. [impl: `mandate.rs::excluded`]

- **NU7 band.** The last pre-NU7 rung targets 3,543,394, so every pre-NU7 rung has at least 10 blocks in which to be mined before activation makes its branch ID invalid. (ZIP 259 notes that v5 and v6 signatures commit to the branch ID.) The band does *not* keep expiry windows from straddling the upgrade, despite what the code comment says. For example, a rung for *T* ∈ [3,543,365, 3,543,394] has expiry *T* + 40 ≥ 3,543,405, yet it cannot be mined at or after 3,543,405.
- **Fee band.** ZIP 2009 says wallets SHOULD use `marginal_fee = 1000` from Mainnet height 3,590,000, which makes the conventional fee for 2 actions 2,000 zatoshis. ZIP 2009 changes relay policy, not consensus. A 10,000-zatoshi installment after the switch would still be valid, but it would pay 5× the new conventional fee and stand out. So the exclusion protects privacy; it is not needed for validity.

  ZIP 2009 gives no Testnet height, and `zcash_primitives` 0.31.0 `FeeRule::standard()` still uses 5,000. The reference implementation therefore cannot build a 2,000-zatoshi installment at all (§ Deployment).


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
- the release rounds strictly increase;
- each Package's header round equals its `release_round`.

The Runner cannot inspect a Package's contents before its round. It records `amount_zat` from the Offer, not from the Package, and it does not check that the rounds follow `period_secs`.


## Runner release rules

The Runner evaluates each subscription whose status is `active` or `stalled` at regular intervals (10 s by default). Before each evaluation it syncs its wallet to *tip*. Only the lowest-numbered installment that is not yet mined, called *k*, is considered.

1. **Open.** The Runner MUST NOT try to open Package *k* before `round_at(now) ≥ r_k`. It MUST fetch the beacon for round *r_k* and verify it before use (§ Sealing). It SHOULD fetch beacons over Tor. It then stores the beacon and moves *k* to `due`. [partial: Tor is used unless `--direct` is set, and `deploy/docker-compose.yml` starts the Mainnet runner with `--direct`, which also turns off Tor for drand.]

   The reference stores only the sealed Package and the public beacon at rest, and opens the Package again in memory on every attempt.
2. **Validate.** Before it broadcasts any rung of *k*, the Runner MUST check all of the following:
   - the Ladder's `k` is *k*;
   - every rung's PCZT is v6;
   - each rung's branch ID is branch(`target_height`), and its expiry equals both `expiry_height` and `target_height` + δ;
   - each rung has exactly one real Ironwood spend, whose nullifier is `spends_nullifier`;
   - one output pays the Offer's `amount_zat` to the Offer's Orchard receiver;
   - any other non-dummy output goes to the change receiver of the pocket UFVK;
   - the fee is the conventional fee.

   **[not impl]** The reference checks only proofs and signatures, through the Transaction Extractor, and trusts the JSON fields (§ Security Considerations).
3. **Target.** The target is `T = tip + 1`. [impl]
4. **Input.** Find the unspent Pocket note whose nullifier is `spends_nullifier`.
   - If there is none, and the input's mined height *m* is known and `tip ≥ m + 3`, treat the Mandate as cancelled (§ Cancellation).
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
   - If it is still unmined when `tip > expiry_height`, move *k* back to `due` and apply rules 3 to 8 again with the new *T*, using the same Ladder. The new rung has byte-identical actions and the same nullifier, so the retry can never pay twice.

   [impl] The condition is conservative: a transaction is already dead once `tip ≥ expiry_height` (ZIP 203).
10. **Missed.** Mark *k* `missed`, set the subscription to `stalled` and send `invoice.expired`. [impl] In the reference this is a dead end: no re-signing path exists, and cancellation detection (§ Cancellation) is not run for a missed installment.
11. **Release-time jitter.** **[not impl, planned]** A Runner MAY wait a random time after *r_k* before releasing. It can never release earlier.
12. **Finish.**
    - When every installment is mined, the subscription becomes `completed`.
    - On cancellation it becomes `cancelled`, and a merchant stop makes it `stopped`. In both cases the remaining installments become `cancelled`.

    Either way, the Runner MUST delete the Pocket's wallet account, the sealed Packages, the beacons and the pocket UFVK. [partial: the reference deletes the wallet account and sets `sealed` and `beacon` to NULL. The UFVK and the raw funding transaction stay in the `pockets` table of `runner-state.sqlite`. The SQLite database runs in WAL mode without `secure_delete`, so the deleted rows are not securely erased.]

State transitions of an installment:

| From | To | When |
|---|---|---|
| `sealed` | `due` | the beacon for *r_k* is verified (rule 1) |
| `due` | `broadcast` | the rung for *T* is broadcast (rules 3–8) |
| `due` | `missed` | *T* is above the highest rung (rule 10) |
| `broadcast` | `mined` | the transaction is mined (rule 9) |
| `broadcast` | `due` | the transaction is unmined and `tip > expiry_height` (rule 9) |
| any but `mined` | `cancelled` | cancellation is detected or the merchant stops (rule 12) |


## Cancellation

**Payer.** To cancel, the payer spends the live note. A cancellation stops Installment *k* only if it is mined before any rung of *k*. Once it is mined:

- every rung of *k* double-spends a nullifier that is already spent;
- the inputs of *k*+1 and later never come into existence, so those installments can never be proved.

The cancellation SHOULD have the installment shape (P2, P3): one spend, `ovk = None`, the default expiry and an anchor at *T* − 3, with fresh randomness rather than a rung seed.

The reference CLI (`cadence-cli/src/subscribe.rs::cancel`) works as follows:

1. It reads the live note's nullifier and its witness from the Runner.
2. It identifies the live note among {*F*, *C(1)*, …, *C(count−1)*}, which it recomputes from *S*.
3. It checks the anchor against the payer's own lightwalletd, over Tor.
4. It pays value(live note) − 10,000 to an Orchard receiver the payer supplies.
5. It proves locally and broadcasts through the payer's own lightwalletd.

The design does not require the Runner's cooperation, because the witness can be derived by scanning with the pocket UFVK. The reference CLI does not do that scan. After the Runner deletes the Pocket account (on completion or a merchant stop), the CLI's cancel path fails, so any residue can only be recovered with other software that can spend an Ironwood note from account 7 of *S*.

**Runner detection.** [impl: `service.rs`]

- *Early.* Detection runs while *k* is `sealed`, once the previous note is settled: *F* is mined, or *k*−1 is mined, at height *m*, and `tip ≥ m + 3`. If the Pocket then holds no unspent note, the Mandate is cancelled.
- *At release.* Rule 4.

Both detections conclude that the payer spent the input without checking which transaction spent it. The Runner SHOULD confirm that the spending transaction is not one of *k*'s own rung txids before concluding that the Mandate was cancelled [not impl]. When it does conclude cancellation, it applies rule 12 with status `cancelled` and sends `invoice.cancelled`.


## Re-signing at network upgrades and fee changes

**[not impl]** The reference implementation has no re-signing flow:

- `cadence resume` refuses to run once a subscription has been uploaded;
- the HTTP binding has no endpoint for replacing Packages;
- `missed` is terminal.

This section specifies the requirement.

Re-signing is required in these cases:

- A network upgrade whose activation height was not known at signing time falls inside a Window. Rungs past it carry the old branch ID and are invalid.
- A change to the conventional fee falls inside a Window. On Mainnet this is ZIP 2009 at 3,590,000; the reference does not sign past that height.
- An installment is `missed`.

To re-sign from Installment *j*, the payer builds new Ladders for every *k* ≥ *j* with attempt *a* + 1, using the current tip and time, and the current δ and fee. It seals them and uploads them. The Runner MUST then discard its old Packages for every *k* ≥ *j*.

Re-signing *k* changes *C(k)*. Every later installment must therefore be re-signed as well.

Old and new rungs of the same *k* share an input nullifier, so at most one of them can be mined. A Runner that kept an old Package can release at most the old schedule; it gains no extra value.

A lower fee leaves a positive change after Installment `count`, which the payer recovers as described under Cancellation. Re-signing requires the payer to come back online, once per upgrade or fee change.


## HTTP binding

The binding is informative. `docs/api.md` is the informative appendix. Every body is JSON, every amount is in zatoshis, and every round is a quicknet round.

| Method and path | Caller | Authentication | Purpose |
|---|---|---|---|
| `POST /api/offers` | merchant | bearer token | create an Offer; returns `share_url = {public_url}/subscribe#offer=<base64url(offer)>` |
| `GET /api/offers/{id}` | payer | none | the Offer (§ Offer) |
| `POST /api/pockets` | payer | none | register a pocket UFVK; birthday = tip + 1 |
| `GET /api/pockets/{id}` | payer | none (the id is a capability) | funding `{txid, tx_hex, mined_height, value_zat}`, unspent notes |
| `GET /api/pockets/{id}/witness?nullifier=` | payer | none | `{target_height, anchor_height, anchor, position, auth_path[32]}` for a cancellation |
| `POST /api/broadcast` | payer (browser) | none | relay a raw transaction |
| `POST /api/subscriptions` | payer | none | upload Packages (§ Subscription) |
| `GET /api/subscriptions` | merchant | bearer token | list subscriptions |
| `GET /api/subscriptions/{id}` | anyone who knows the id | none | one subscription and its installments |
| `POST /api/subscriptions/{id}/stop` | merchant | bearer token | stop and shred (rule 12) |
| `GET /api/decode/{txid}`, `GET /api/status` | anyone | none | public transaction shape; tip and current round |
| `POST /api/sandbox/fund` | anyone, Testnet only | none | fund a pocket from the custodial sandbox wallet |

Webhooks are sent as `POST`s with the header `X-Cadence-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`. The body is `{type, subscription_id, k, txid|null, amount_zat, mined_height|null}`. The event types are `invoice.confirmed`, `invoice.expired` and `invoice.cancelled`.


# Rationale

## Lineage

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

Nothing in an Ironwood-only v6 transaction gives it a lower height bound. `nLockTime` is enforced only when some transparent input is non-final, following Bitcoin's finality rule, so it cannot constrain a transaction with no transparent inputs. A non-zero `lock_time` would also be a fingerprint: 100% of the mainnet class has `lock_time = 0`. Once the input note exists, a rung can be mined at any height up to its expiry.

The party that must be stopped from releasing early is the one holding the Package. A time-lock that the holder cannot open is therefore the mechanism. tlock with drand quicknet [^tlock] provides it under a threshold assumption. Sealing needs only the chain's public key, so the payer never contacts drand.

age is the inner layer, so a tlock failure exposes Packages only to the Runner.

## v6 expiry for "not after"

The v6 sighash commits to the header, including `nExpiryHeight` and the consensus branch (ZIP 229, which computes digests as in ZIP 244 [^zip-0244] with the anchors moved to authorizing data). Expiry gives a consensus-enforced upper bound: Installment *k* can never be mined above max(`target_height`) + δ.

ZIP 318 signs each transaction once with a long canonical expiry. That shape suits a coordinated migration population. Here it would produce `expiry − mined` values far above δ, which ordinary sends never show (P2). Signing one rung per height, and broadcasting only the rung for exactly tip + 1, makes `expiry − target` = δ, as in a stock send.

## Self-spend cancellation

A signed transaction can be revoked only by making its input unspendable. Spending the live note does that, consensus enforces it, and the Runner's cooperation is not needed. The cancellation costs one fee and looks like an installment (`evidence/E2E-service-testnet.md`, run 2).

## Other choices

- **Chained change notes instead of pre-split notes.** One funding payment, no preparation transactions, and 2 actions per installment. The cost is that *k*+1 cannot be released until *C(k)* is anchor-deep.
- **Anchor at *T* − 3.** ZIP 315 [^zip-0315] recommends anchoring at the trusted confirmation depth of 3, and `zcash_client_backend` does the same. *F* comes from outside the Pocket, so ZIP 315 would call it untrusted and require 10 confirmations; this ZIP uses 3. That is a *Choice*. A reorg of *F* can only delay Installment 1.
- **Discard.** The pocket UFVK includes the Pocket's OVKs. If change and cancellation outputs used them, the Runner could decrypt where cancelled funds went. With Discard, `out_ciphertext` is undecryptable, just as stock outgoing ciphertexts are to anyone without the sender's OVK.
- **Fresh seed and a non-zero account.** A Pocket shares no key material with the main wallet. The non-zero account is defense in depth: if *S* were ever imported into a stock wallet, that wallet would restore account 0, find nothing, and so never sweep the Pocket with the default OVK, which the Runner could decrypt.
- **Keyed PRF seed.** P1 needs a single seed per installment. The payer has to be able to recompute *C(k)* from *S*. Nobody else may be able to compute the seed, because it determines `esk` and `rcv`, and with those anyone could decrypt the outputs and open the value commitments. `mandate_id` is not secret (the wasm signer puts it in the memo), so the seed must be keyed.
- **Bucket padding.** The size of a Package reveals only its bucket. Identical actions across rungs compress well under zstd: each Package in the testnet run, with 157 to 175 rungs, fit the 64 KiB bucket.


# Privacy Implications

## Chain observer

Each installment is v6 and Ironwood-only, with 2 actions, `flags = 7`, `lock_time = 0`, a fee of 10,000, a 7,264-byte proof, expiry *T* + δ and an anchor at *T* − 3. On testnet every installment and the cancellation decode with 0 outputs recoverable under the all-zero OVK and 0 under the Pocket's OVKs (`evidence/S2-testnet.md`, `evidence/E2E-service-testnet.md`).

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
- the refund amount, by arithmetic: the reference cancellation pays value(live note) − 10,000.

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

- **Periodic release.** The Runner releases at the first evaluation after three conditions hold: *r_k* has passed, *N_k* is anchor-deep, and a rung exists. Installments therefore form a series with period `period_secs`, plus block granularity. The only defense is the size of the class: about 0.84 per block in the pre-NU7 sample. Release-time jitter is **not yet implemented**. The threat model's statement that the "scheduler adds jitter" describes a planned feature.
- **Funding proximity.** With the CLI default `--first-in 60`, Installment 1 is mined within a few blocks of the funding transaction. That is a timing correlation, though not a cryptographic link.
- **Expiry retries.** A retry spends the same nullifier, which is inherent to spending the same note, so a mempool observer can link the two broadcasts. The `attempt` input of the seed would not prevent this.
- **Chaining.** Installment *k*+1 cannot be mined until *C(k)* is anchor-deep, which matters only for short periods.

## Network and infrastructure

- **Payer to Runner.** The reference CLI reaches the Runner with a plain `ureq` HTTP client, not through its embedded arti client. The Runner therefore sees the CLI user's IP address during subscription, funding polls and cancellation. This contradicts the README's statement that the Runner never learns the payer's IP when the CLI is used. The CLI's chain access does go over Tor. The web build is disclosed as clearnet unless it is used through Tor Browser with an onion address.
- **drand relays.** The reference Runner fetches beacons over Tor unless `--direct` is set (see rule 1). Package headers reveal *r_k* to anyone who stores them.
- **Capabilities in the HTTP binding.** `GET /api/pockets/{id}` and `GET /api/subscriptions/{id}` are unauthenticated. Their 80-bit random ids act as bearer capabilities that expose funding data, notes, the schedule and txids.


# Security Considerations

- **Spend authority.** The Runner never holds *ask_P*. Amounts, recipients, the fee, the expiry and the branch are under the spend authorization and binding signatures. Every rung of *k* spends the same nullifier, so at most one installment *k* is ever mined. A replay after a cancellation is a double-spend.
- **drand threshold.** "Not before" assumes that fewer than a threshold of the League of Entropy's quicknet nodes collude, and that the BLS12-381 assumptions hold.

  If that assumption fails, the Runner, and only the Runner, can open every Package at once. It can then release each remaining installment as soon as its input is anchor-deep, about 3 blocks per installment. It would have to use inexact rungs, which leave a visible `expiry − mined > δ`.

  The amounts and the recipient are unchanged, so the loss is at most early payment of the whole prefunded Mandate: at most `count` ≤ 12 installments. The threat model's "rolling funding (at most a few periods per pocket)" is **not implemented**; the whole Mandate is prefunded.

  If drand halts, Packages stay locked, installments are missed, and the funds stay in the Pocket under the payer's control.
- **`tlock_age` 0.0.10 is unaudited.** Its decryption panics (`assert_eq!` in `ibe::decrypt`) when the signature is wrong or the stanza is inconsistent. Anyone who knows the Runner's recipient can craft such a stanza. `cadence-seal` hardens against this in three ways:
  - it verifies the beacon before decrypting;
  - it runs tlock decryption under `catch_unwind` and maps a panic to `MalformedTimeLock`;
  - it pre-checks chain keys when sealing.

  The panic boundary requires `panic = "unwind"`. The workspace sets no panic profile, so the default applies; under `abort`, a crafted Package would kill the process. Confidentiality against third parties rests on age X25519 alone.
- **Runner identity compromise.** Someone who obtains both the Runner's age identity and its stored Packages can read each Ladder after its round. They learn the pocket FVK and can broadcast installments, which still pay the merchant.
- **Runner liveness.** If the Runner is down for a whole Window, the installment is missed and the funds stay with the payer. In the reference implementation `missed` is terminal (§ Re-signing).
- **FVK non-revocability.** A viewing key cannot be revoked. The exposure is bounded by single-use Pockets: the FVK reveals only this Pocket, which is empty after an exactly funded Mandate completes. Pocket addresses MUST NOT be reused.

  A malicious Runner can keep copies of everything. An honest one MUST delete the UFVK (rule 12), and the reference does not yet delete it from its state database.
- **Merchant-side validation gap.** Rule 2 is not implemented. A payer can seal a Ladder whose valid signatures pay someone other than the merchant, for example the Pocket itself. The reference Runner would broadcast it, mark it `mined`, and send `invoice.confirmed` with the Offer's amount. Merchants MUST NOT treat `invoice.confirmed` as proof of receipt until rule 2 is implemented.
- **Misclassification and reorgs.** "Input spent" is taken to mean "payer cancelled", and an installment is marked `mined` the first time it is seen, with no reorg handling. A missed observation of the Runner's own mined installment, followed by expiry, or a reorg that drops an installment whose anchor was also reorged, can lead the Runner to report a cancellation that never happened.
- **Trusted JSON fields.** The Runner selects rungs by the payer-declared `target_height` and schedules retries by `expiry_height`, without checking either against the PCZT. A lying payer affects only its own privacy and liveness.
- **Hostile Packages.** A Package is bounded in several ways:
  - decompression is capped at 64 MiB, with a single zstd frame and no trailing data, using the pure-Rust ruzstd decoder;
  - frame padding must be zero;
  - the HTTP body limit is 80 MiB.

  A Package that fails to open leaves its installment `due` and is retried at every evaluation, without any webhook. A Package that opens but fails to prove is retried until its rungs run out.
- **Builder determinism.** P1 depends on the exact builder version (§ Builder randomness). An upgrade between signing and cancellation can make the payer's recomputed *C(k)* wrong. The reference CLI would then refuse to cancel ("a note this pocket never created") until the right version is used.
- **Payer key custody.** *S* is the only spend authority. If *S* is stolen, the thief can sweep the Pocket. If *S* is lost, the payer can no longer cancel, and the Mandate runs to completion as signed.


# Deployment

This ZIP needs no consensus change. It requires:

- NU6.3 or later, for v6 transactions and the Ironwood pool;
- PCZT v2 with deferred anchors (ZIP 374);
- a lightwalletd that serves Ironwood tree states;
- drand quicknet.

Status as of 2026-10-22:

- On NU7 testnet, a view-only Runner has released three chained installments (`evidence/S2-testnet.md`).
- The full service has run on NU7 testnet: subscribe, release, completion, cancellation, and a run with everything over Tor (`evidence/E2E-service-testnet.md`).
- A mainnet run has not been done.

**NU7.** Windows may straddle activation, because each rung is signed with the branch for its own target height. The S1 test checks identical actions on both sides. A pre-NU7 rung that is broadcast but not mined by height 3,543,404 is dead at activation. The reference Runner retries only after `tip > expiry_height`, which can be up to 29 blocks (about 12 minutes) after activation. A Runner SHOULD instead treat such a rung as expired at activation [not impl].

**ZIP 2009 on Mainnet.** The reference implementation cannot release any installment at or above height 3,590,000. If an installment's Window lies entirely at or above that height, presigning fails with `EmptyWindow`, so the whole subscription fails. Windows that cross the height are cut short there, and those installments are missed if the chain gets there first.

ZIP 2009 expects height 3,590,000 in mid-December 2026. Under ZIP 218's 25 s spacing, the code's model puts it about 13.5 days after NU7 activation (46,595 blocks). The guard depends only on the height, not on the date.

Either way, a monthly Mandate signed on Mainnet today fails at Installment 2. Mainnet Mandates beyond that height need a 2,000-zatoshi fee rule and the re-signing flow (§ Re-signing).

**Future upgrades.** Rungs past an activation that was not scheduled at signing time carry the old branch, and nodes reject them. A Runner SHOULD check that branch(*T*) matches the rung's branch before proving, to avoid wasted proofs [not impl]. The Mandate then needs re-signing.


# Reference Implementation

<https://github.com/OoJae/cadence> (MIT OR Apache-2.0). It pins `zcash_primitives` =0.31.0, `pczt` =0.10.0, `orchard` =0.16.0, `zcash_protocol` =0.11.0, `zcash_keys` =0.17.0, `zcash_client_backend` =0.25.0, `zcash_client_sqlite` =0.23.0, `tlock_age` =0.0.10 and `age` 0.11.

| Component | Path |
|---|---|
| Pocket, rung, randomness, schedule and window, redaction | `crates/cadence-core/src/{pocket,rung,seed,mandate,package}.rs` |
| Sealing, drand | `crates/cadence-seal/src/{lib,seal,drand}.rs` |
| Wallet: import, anchor and witness, check, complete | `crates/cadence-chain/src/wallet.rs` |
| Runner: release rules, HTTP binding, webhooks | `crates/cadence-runner/src/{service,api,store,webhook}.rs` |
| Payer CLI: subscribe, resume, cancel | `crates/cadence-cli/src/{main,subscribe}.rs` |
| Browser signer | `crates/cadence-wasm` |
| Shape decoder and fingerprint scanner | `crates/cadence-decode` |
| Tests | `cargo test -p cadence-core` (S1 determinism), `cargo test -p cadence-seal` |
| Evidence | `evidence/S2-testnet.md`, `evidence/E2E-service-testnet.md`, `evidence/fingerprint-mainnet-sample.json` |

Known differences between this draft and the reference implementation, also marked inline:

| Item | Status |
|---|---|
| Validating the Ladder against the Offer before broadcast (rule 2) | not impl |
| Release-time jitter (rule 11) | not impl, planned |
| Re-signing flow, and recovery from `missed` | not impl |
| Deleting the pocket UFVK and funding transaction at finish (rule 12) | partial |
| Confirming that the spender is not the installment itself before declaring cancellation | not impl |
| Cancellation after the Runner deletes the Pocket account | not supported by the CLI |
| Runner traffic from the CLI over Tor | not impl (plain `ureq`) |
| drand over Tor in the Mainnet compose file | disabled by `--direct` |
| Memo tag conforming to ZIP 302 | no (§ Memo) |
| Rolling funding (from the threat model) | not impl |

Differences between `docs/api.md` and the code:

- The share URL is `{public_url}/subscribe#offer=…`, not `/#offer=…`.
- Subscription status can also be `stopped`.
- Installment state `cancelled` is also set when the merchant stops.
- Webhook bodies also carry `mined_height`, and `txid` may be null.
- "Crypto-shreds" overstates what the Runner does (rule 12).
- `GET /api/subscriptions` requires the merchant token.
- `GET /api/pockets/{id}` and `GET /api/subscriptions/{id}` are unauthenticated.


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

[^zip-2009]: [ZIP 2009: Reduce Marginal Fee to 1000 Zatoshis and Raise the Weight Ratio Cap to 10](https://zips.z.cash/zip-2009)

[^pool-migration]: [`zcash_pool_migration` 0.2.0 (librustzcash)](https://crates.io/crates/zcash_pool_migration)

[^zcash-primitives]: [`zcash_primitives` 0.31.0, `transaction::builder::DeferredPcztBuilder`](https://docs.rs/zcash_primitives/0.31.0)

[^tlock]: [Gailly, Melissaris, Romailler, "tlock: Practical Timelock Encryption from Threshold BLS", IACR ePrint 2023/189](https://eprint.iacr.org/2023/189); [drand quicknet](https://drand.love); [age v1](https://age-encryption.org/v1)

[^RFC9380]: [RFC 9380: Hashing to Elliptic Curves](https://www.rfc-editor.org/rfc/rfc9380)
