# Mainnet run (2026-10-27)

Two mandates, subscribed on Zcash mainnet from Zodl on 2026-10-27. Both were opened from the independent app host (https://app-production-be97.up.railway.app, build `9447450`), signed in the browser (WASM signer) and handed to the mainnet runner. Then the tab was closed. They pay a separate wallet that installed nothing. Every transaction below is real mainnet activity, decodable by anyone.

## The short run: 3 × 0.001 ZEC, every 10 minutes

Subscription `sub_743358fc3614c8145f4a` (offer `off_d9e88ebfe9f01b677545`, pocket `pkt_dd0aaec630f4dcb20862`). The payer paid 0.0033 ZEC once, which covers every installment and its fee. The subscription completed.

| | txid | release (drand round) | target | mined | expiry − mined | anchor depth |
|---|---|---|---|---|---|---|
| Funding (Zodl → pocket) | `3f1c3c399cfbbe7b79a54c55f300c801d03ec7be61199e4304da8d02a5e0e63e` | | | 3,532,615 | 38 | 5 |
| Installment 1 | `74edd53ed10d420017ed3f400be1be142a45ffe07720e1d7cc3dcdbd3b9cda85` | 16:46:45 UTC (33,438,747) | 3,532,618 | 3,532,618 | 40 | 3 |
| Installment 2 | `bfad85310a3b374efdd973bf5e8a1c0c56acf7cfb7de674cce4cfd499f8411b3` | 16:56:45 UTC (33,438,947) | 3,532,624 | 3,532,624 | 40 | 3 |
| Installment 3 | `a57fd9d88c1411d57984e6104fd4d8f7d98984ff7a65d8bbbb49f695e3957e6c` | 17:06:45 UTC (33,439,147) | 3,532,631 | 3,532,631 | 40 | 3 |

Each installment was mined in the block it targeted.

## The live mandate: 4 × 0.001 ZEC, weekly, through judging

Subscription `sub_747f99039ba4f43c5234` (offer `off_27dee6ad856ca8d853aa`, pocket `pkt_6f6f8fdc76a804717c69`), named "Weekly contributor stipend". The payer paid 0.0044 ZEC once and closed the tab.

| | txid | release (drand round) | target | mined | expiry − mined | anchor depth |
|---|---|---|---|---|---|---|
| Funding (Zodl → pocket) | `120bd07611128e3c3801a9f457885089647f0ca25ad800c2df02a85a2a9da1cf` | | | 3,532,624 | 34 | 9 |
| Installment 1 | `f5531143d2f15b7f46d9492fdb54aaa91583548249e9c712a4941fc6da970a91` | 2026-10-27 17:00:27 UTC (33,439,021) | 3,532,627 | 3,532,628 | 39 | 4 |
| Installment 2 | sealed | 2026-11-03 17:00:27 UTC (33,640,621) | | | | |
| Installment 3 | sealed | 2026-11-10 17:00:27 UTC (33,842,221) | | | | |
| Installment 4 | sealed | 2026-11-17 17:00:27 UTC (34,043,821) | | | | |

Live status, polled from the mainnet runner: https://main-production-d975.up.railway.app/status#sub=sub_747f99039ba4f43c5234 (it shows times in your browser's time zone; this page gives them in UTC).

**Across NU7.** Mainnet NU7 activates at height 3,543,405 (`crates/cadence-core/src/mandate.rs`). At 75-second blocks from the tip when this was written (3,532,640), that is around 5 November: after installment 2 and before installment 3. Each rung is signed for the consensus branch and expiry at its own height. So installment 3, signed on October 27, already carries the NU7 branch and its 120-block expiry, and will be the first Cadence installment after the upgrade. The status page marks it when it lands.

## Shape: a Cadence installment next to the payer's own Zodl send

Decoded by the mainnet runner (`GET /api/decode/:txid`, the same fields as `cadence-decode`); the six decodes are in [`mainnet-decoded.json`](mainnet-decoded.json). The funding transactions were sent by Zodl. The installments were built and released by Cadence. To see one side by side with the payer's own Zodl send: https://main-production-d975.up.railway.app/decode/74edd53ed10d420017ed3f400be1be142a45ffe07720e1d7cc3dcdbd3b9cda85?compare=3f1c3c399cfbbe7b79a54c55f300c801d03ec7be61199e4304da8d02a5e0e63e

| Field | Zodl's funding sends | Cadence installments |
|---|---|---|
| Version, branch | V6, `37a5165b` | V6, `37a5165b` |
| `lock_time` | 0 | 0 |
| Transparent in / out | 0 / 0 | 0 / 0 |
| Sapling spends / outputs | 0 / 0 | 0 / 0 |
| Orchard-pool actions | 0 | 0 |
| Ironwood actions, flags | 2, 7 | 2, 7 |
| Fee | 10,000 zats | 10,000 zats |
| Proof size | 7,264 bytes | 7,264 bytes |
| Outputs readable with the zero OVK | 0 | 0 |
| Expiry − mined | 38, 34 | 40, 40, 40, 39 |
| Anchor depth | 5, 9 | 3, 3, 3, 4 |

Every structural field is identical. Only the timing fields differ, and they follow one rule for both. Each transaction anchors 3 blocks below, and expires 40 blocks after, the height it was built for. So the depth and the expiry left show only how long it waited to be mined. Zodl's sends waited 2 and 6 blocks; the installments went in at their target or one block after.

## What the payee received

Each installment pays 0.001 ZEC to the payee's shielded address, with a ZIP 302 text memo the payee's wallet shows. The payer's signer writes it into each rung, under the payer's signature, so the runner cannot change it. It reads as on testnet (`evidence/railway-sandbox.md`): `Cadence · <plan name> (<pocket id>) · payment k of n`, for example `Cadence · Mainnet short run (pkt_dd0aaec630f4dcb20862) · payment 1 of 3`. The payee installed nothing.

## Check it yourself

```sh
cadence-decode decode --network main 74edd53ed10d420017ed3f400be1be142a45ffe07720e1d7cc3dcdbd3b9cda85   # over Tor
```

Or open a txid in the mainnet runner's decoder: https://main-production-d975.up.railway.app/decode/74edd53ed10d420017ed3f400be1be142a45ffe07720e1d7cc3dcdbd3b9cda85
