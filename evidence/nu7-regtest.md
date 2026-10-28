# NU7 rehearsal on a local regtest chain (2026-10-28)

The live mainnet mandate (`evidence/mainnet.md`) has an installment already signed for NU7's consensus branch, `77190ad9`, for heights after NU7 activates on mainnet. Testnet passed NU7 long ago, so this rehearsal used a local Zebra regtest chain with NU7 at height 200. A payer signed a 3-installment mandate at height 193, while the node still reported NU7 as `pending`. Every rung of installment 3 was signed for the NU7 branch. The chain was then mined through activation, and the runner released all three installments: one before NU7 and two after.

This is a local chain with no proof of work, mined on demand. The txids below exist on no public network, and nobody else can look them up. Rerunning `scripts/regtest/rehearse.sh` repeats the run with fresh keys and new txids.

## Setup

- **Node.** `zfnd/zebra:7.0.0`, the linux/arm64 image, run natively under Docker on Apple Silicon. `zebrad --version` printed `7.0.0+git.e8db87e`. Its config is [`scripts/regtest/zebrad.toml`](../scripts/regtest/zebrad.toml): `network = "Regtest"`, every upgrade through NU6.3 at height 1, NU7 at 200, and ephemeral state. `getblockchaininfo` listed NU7 (`77190ad9`) with activation height 200, `pending` at the start and `active` at the end.
- **Light server.** Zebra's own lightwalletd gRPC service (`rpc.lightwalletd_listen_addr`). The runner's wallet sync, the CLI and `cadence-decode` all used it, and no separate lightwalletd ran.
- **Mining.** `generate` and `generatetoaddress`. Four coinbase outputs at heights 10–13 paid the sandbox funder's Ironwood address, 6.25 ZEC each.
- **Cadence.** Built from `ca20741` plus the regtest network option (`--network regtest`, `crates/cadence-chain/src/params.rs`), before it was committed as `d155873`. The commit differs from the build only in comments, `--help` text and one test assertion. One runner ran with `--network regtest --direct --drand-direct --tick 5`, with the sandbox funder enabled. The CLI ran `cadence subscribe --sandbox-fund --first-in 60` against an offer of 3 × 100,000 zats every 720 s, paying a separate merchant pocket.
- **drand.** Real quicknet. The CLI sealed each package to a future round, and the runner fetched each beacon from `https://api.drand.sh` over the internet, without Tor.

```sh
CARGO_BUILD_JOBS=3 KEEP=1 scripts/regtest/rehearse.sh
```

The script does every step below and logs each one. The defaults it used were `FUND_AT=193`, `FIRST_IN=60`, `PERIOD=720` and `AMOUNT=100000`.

## Timeline (UTC, from the script's log)

| Time | Height | What happened |
|---|---|---|
| 06:30:22 | 1 | Zebra up on regtest. NU7: activation height 200, `pending`. |
| 06:30:30 | 192 | The runner synced the funder: 4 notes, 2,500,000,000 zats. The merchant created offer `off_58eeae4824c5ad544058`. |
| 06:30:42 | 193 | The sandbox funded pocket `pkt_b267ee1e9cc8dca05f69` with 330,000 zats in `41217c96…5d75f7`, mined at 193. Nothing else was mined until the subscription was active. |
| 06:30:49–06:31:00 | 193 | The CLI signed every rung at tip 193, sealed each installment to its drand round, and uploaded. The node still reported NU7 as `pending`. Subscription `sub_3fc2f81aaeb7d07d2746`. |
| 06:31:53 | 193 | Installment 1's round passed. The runner opened it and waited for the funding to be anchor-deep (3 blocks). |
| 06:33:40 | 195 | The runner broadcast installment 1 for target 196, anchored at 193. |
| 06:33:42 | 196 | Installment 1 mined at 196, on NU6.3 (`37a5165b`). |
| 06:37:27 | 199 | The last NU6.3 block. |
| **06:37:52** | **200** | **NU7 activates.** Blocks from here carry `77190ad9`. |
| 06:43:58 | 214 | Installment 2's round passed. |
| 06:44:05 | 215 | Installment 2, broadcast for target 215 (anchor 212), mined at 215 on NU7. |
| 06:55:54 | 243 | Installment 3's round passed. |
| 06:56:03 | 244 | Installment 3, broadcast for target 244 (anchor 241), mined at 244 on NU7. The subscription completed, and the runner deleted the pocket's data. |

The script mined like a chain clock: one block 75 s after the last before NU7, one every 25 s from NU7 on, and one 2 s after any transaction reached the mempool. Those are the block times Cadence predicts with (`mandate.rs`). Each broadcast was mined in the block it targeted.

## What the payer signed at tip 193

From the CLI's output (`subscribe.log`). The branch IDs are those of the first and last rung of each window.

| # | Rungs | Heights | Branches | drand round |
|---|---|---|---|---|
| 1 | 150 | 194..=343 | `37a5165b` (194–199) to `77190ad9` (200–343) | 33,455,249 |
| 2 | 183 | 194..=376 | `37a5165b` (194–199) to `77190ad9` (200–376) | 33,455,489 |
| 3 | 215 | 202..=416 | `77190ad9` only | 33,455,729 |

Installment 3's window starts at 202, so all 215 of its rungs were signed for the NU7 branch at 06:31, seven blocks and about seven minutes before NU7 activated. Installments 1 and 2 straddle activation, which the spec allows: each rung carries the branch for its own height. Installment 1 was mined from its NU6.3 part, and installment 2 from its NU7 part.

## The transactions

| | txid | target | mined | branch | expiry | expiry − mined |
|---|---|---|---|---|---|---|
| Funding | `41217c9668df0474b36c670d92eab86ce44622f67278384989377f0d035d75f7` | | 193 | `37a5165b` | 233 | 40 |
| Installment 1 | `e73b19db7b4eab98afc9bb8083bb07c921a7e6ea57f762ebe34f7771937eb18e` | 196 | 196 | `37a5165b` | 236 | 40 |
| Installment 2 | `6d730d840da737dc3c36c2839daa90543a27ff00cede3307da17bd33ef6528f9` | 215 | 215 | `77190ad9` | 335 | 120 |
| Installment 3 | `79a27b64633501795b291758244cc38707b7b68fabedeb6653e2987f805f2084` | 244 | 244 | `77190ad9` | 364 | 120 |

Zebra's `getrawtransaction` agreed on each mined height and expiry: v6, version group `d884b698`.

Decoded with `cadence-decode decode --network regtest --direct --view <merchant UFVK>`. The full output is in [`nu7-regtest-decoded.json`](nu7-regtest-decoded.json).

- **Format:** V6 for all four, with `lock_time = 0`. Installment 1 carries the NU6.3 branch, and installments 2 and 3 carry NU7's.
- **Pools:** 0 transparent inputs and outputs, no Sapling, no Orchard-pool actions, and 2 Ironwood actions (flags 7) in each installment.
- **Fee:** an Ironwood value balance of 10,000 zats in each, the ZIP 317 fee for 2 actions.
- **Expiry:** target + 40 on NU6.3 and target + 120 on NU7, the default delta of each branch. Mainnet shows the same 40 before NU7 (`mainnet.md`), and testnet shows 120 after it (`S2-testnet.md`).
- **Proof:** 7,264 bytes each.
- **Outgoing ciphertexts:** 0 outputs recoverable with the all-zero OVK.
- **Payee view:** with the merchant's UFVK, each installment shows 100,000 zats and the memo `Cadence · NU7 rehearsal (pkt_b267ee1e9cc8dca05f69) · payment k of 3`.
- **Anchors:** the decoder searches the 12 blocks below the mined height for roots that match the anchor. For installment 1 it found 193–195. For installments 2 and 3 it matched all 12 blocks it searched: 203–214 and 232–243. The script's clock blocks pay a transparent address, so they add no Ironwood commitments and leave the root unchanged. Each run contains the height the runner said it anchored at: 193, 212 and 241.

## What this does not show

- **One run on a local chain.** Regtest skips proof of work, there are no peers, and every block was mined by the script. Zebra's block header times are regtest times, not wall-clock times; the times above come from the script's log.
- **The mainnet NU7 guard band** (no rungs in the 10 blocks before activation) is mainnet-only, so it was not exercised. Nor was the runner's `branch_passed` re-release, since no NU6.3 rung was left unmined at activation.
- **The funding came from the regtest sandbox funder.** It is a custodial dev pocket that coinbase paid, not a payer's own wallet.
