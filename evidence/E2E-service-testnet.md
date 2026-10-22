# The Cadence service end to end on NU7 testnet (2026-10-22)

Both runs use the real `cadence-runner serve` (HTTP API, drand scheduler, webhooks) and
the payer CLI `cadence subscribe` / `cadence cancel`, against public testnet
lightwalletd (`testnet.zec.rocks`).

## Run 1: a subscription runs to completion

The offer is 3 × 0.001 TAZ, one installment every 120 s. The payer funded the pocket
with one shielded payment (`e696bbf6…7fd7`, mined at 4,529,464). The CLI presigned
157, 167 and 175 rungs and sealed each installment to its drand round. Every
package was exactly 64 KiB. Then it printed "You can close this now".

| # | drand round opened | txid | target | mined |
|---|---|---|---|---|
| 1 | 33293711 | 2f1154c7f02916d5c2f36a5091ca39077eb9ba01a3f7b3a29f6aee0540c7006e | 4529470 | 4529470 |
| 2 | 33293751 | 4eb4e11cc0d37dcafb934b715a9ab9d81e80e9e49bc95bc284a3491b597b589b | 4529476 | 4529480 |
| 3 | 33293791 | 378de5bb6ec76cf31e9f363783e5e8452f6c73dc96727279d387ae5604903262 | 4529483 | 4529488 |

Status went to `completed`, then the runner deleted the pocket account, sealed packages and beacons.
Decoded shapes: `e2e-service-testnet-decoded.json`.

## Run 2: cancel

The offer is 3 × 0.001 TAZ, one installment every 600 s. The sandbox wallet funded the
pocket (`8a0fd762…cfd6`).

1. Installment 1, `b009f1ab30022a9070f4729ab4ef66f69872a7cbc7093612237c35ba590eaf24`, was mined at 4,529,503.
2. The merchant received `invoice.confirmed` with a valid `X-Cadence-Signature` HMAC.
3. The payer ran `cadence cancel`. It rebuilt the live note, proved locally, checked the anchor against an independent server, and broadcast `6594ea6cf9d773b9afc11a8e8628328393eace24c5297f33bdb3dd637df56de3` (mined at 4,529,506). That refunded 210,000 zats to the payer's own address.
4. The runner saw that the pocket was empty and marked the subscription cancelled. Installment 2 can never become valid, because its input no longer exists.
5. The runner deleted the pocket data, and the merchant received `invoice.cancelled` with a valid HMAC.

Decoded (`cancel-testnet-decoded.json`, decoded with the pocket's own UFVK, the one the runner held):

| tx | version | transparent | Ironwood actions | fee | expiry − mined | zero-OVK outputs | pocket-OVK outputs |
|---|---|---|---|---|---|---|---|
| installment 1 | V6 | 0 | 2 | 10,000 | 117 | 0 | 0 |
| cancel | V6 | 0 | 2 | 10,000 | 120 | 0 | 0 |

The cancel has exactly an installment's shape. Even with the pocket's full viewing
key, the runner cannot decrypt where the refund went.
