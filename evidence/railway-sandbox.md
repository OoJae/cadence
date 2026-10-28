# Public sandbox run (testnet, Railway)

The judge sandbox at https://sandbox-production-1e16.up.railway.app/sandbox, driven from a clean browser on 2026-10-23. Everything below is real testnet activity, decodable by anyone. The sandbox's faucet wallet is ours (custodial testnet funds, disclosed on the page), and it is also the merchant, so payments flow back to it.

## The run

Subscription `sub_95ae57cc5bf9c31d2a21`: 3 × 0.001 TAZ, one every 90 s. It was signed in the browser (WASM signer), then the tab was left alone.

| | txid | target | mined | expiry − mined |
|---|---|---|---|---|
| Funding (faucet → pocket) | `a92bec446df5e3ea923d56e3678a5152c55600d3d93fbbe9f88df67062561bf2` | | 4,532,706 | 120 |
| Installment 1 | `9fcf20177a4f763a9e2f0d54fc2957d75b4a243b969742cca993e52758315fc4` | 4,532,711 | 4,532,713 | 118 |
| Installment 2 | `a9a4a3f804ee6134d26addb72a67964a8b4fe61fd39c3459ff263fb37647dda5` | 4,532,716 | 4,532,721 | 115 |
| Installment 3 | `d055e2e2004b969459ae62bd685dd053a12eec4e5865f2e5c4fed9125db73e9f` | 4,532,724 | 4,532,735 | 109 |

The runner log for the run, from Railway:

```
14:30:13  #1: round 33320813 passed, package opened
14:30:20  #1: broadcast 9fcf2017… for target 4532711 (anchor 4532708)
14:31:30  #1: mined at 4532713
14:31:37  #2: round 33320843 passed, package opened
14:32:07  #2: broadcast a9a4a3f8… for target 4532716 (anchor 4532713)
14:33:56  #2: mined at 4532721
14:34:16  #3: round 33320873 passed, package opened
14:35:07  #3: broadcast d055e2e2… for target 4532724 (anchor 4532721)
14:37:06  #3: mined at 4532735
14:37:06  completed; pocket data deleted
```

## Shape

Decoded with `cadence-decode decode <txid> --view <merchant UFVK> --direct`. Every installment is:

- v6 on NU7 (branch `77190ad9`), `lock_time = 0`;
- 0 transparent inputs and outputs, 0 Sapling, 0 Orchard-pool actions;
- 2 Ironwood actions, flags 7, a fee of 10,000 zats and a 7,264-byte proof;
- unreadable from its outgoing ciphertexts: 0 outputs open with the zero OVK.

What the merchant's own viewing key sees in each installment is one output of 100,000 zats with a ZIP 302 text memo:

```
Cadence · Sandbox standing order (pkt_2d0138ae2131d1d82db7) · payment 1 of 3
Cadence · Sandbox standing order (pkt_2d0138ae2131d1d82db7) · payment 2 of 3
Cadence · Sandbox standing order (pkt_2d0138ae2131d1d82db7) · payment 3 of 3
```

**A timing tell, and its cause.** Installments 2 and 3 were mined 5 and 11 blocks after their target heights, so their `expiry − mined` is 115 and 109, where a send mined right away shows 120. The log shows why. The runner opened each package on one scheduler tick and released it on the next. It took the target from the tip it read at the start of that tick, then proved, and by the time it broadcast (30–51 s after opening) the target was already behind the chain. Testnet then mined a burst of blocks. The runner now releases in the same tick and reads the tip again just before choosing the rung (`9ea446c`). The re-run is below.

## Cheats, tried against the live runner

| Attempt | Refused by | Runner output |
|---|---|---|
| Open installment 3 early | tlock (drand) | `cadence-seal: InvalidBeacon { round: 33320873 }`: the newest beacon was round 33320817 |
| Tamper with installment 1's amount (+1 zat, reusing the payer's authorization) | signature check | `pczt signer: IronwoodSign(InvalidExternalSignature)` |

## Check it yourself

```sh
cadence-decode decode 9fcf20177a4f763a9e2f0d54fc2957d75b4a243b969742cca993e52758315fc4   # over Tor
```

Or paste a txid into https://sandbox-production-1e16.up.railway.app/decode.

## Re-run after the fix, from the independent app host (2026-10-26)

This run was driven from https://app-production-be97.up.railway.app/sandbox. That app host serves the web app from its own origin, and the runner answers it over CORS. The run was subscription `sub_464ff6bdca0cd49332f6`: 3 × 0.001 TAZ, one every 90 s. The cancel key was downloaded and then verified (re-opened in the tab with its passphrase) before the page offered to close.

| | txid | target | mined | expiry − mined |
|---|---|---|---|---|
| Installment 1 | `03d76131002fbdcde470b16b5688a8cbcc23667f291dbf52451a0964924bed9f` | 4,545,251 | 4,545,253 | 118 |
| Installment 2 | `31b11c6e2c99c0c386bd1a675b143545ad54810392d7252df5c7a79c626fc225` | 4,545,256 | 4,545,259 | 117 |
| Installment 3 | `706465269dd006492028d65987d9972b0bc9303d47cfbc72b5cb87a6d527d3e4` | 4,545,262 | 4,545,263 | 119 |

```
21:11:41  #1: round 33415241 passed, package opened
21:11:46  #1: broadcast 03d76131… for target 4545251 (anchor 4545248)
21:13:47  #2: round 33415271 passed, package opened
21:14:47  #2: broadcast 31b11c6e… for target 4545256 (anchor 4545253)    waited for #1's change to be 3 blocks deep
21:16:57  #3: round 33415301 passed, package opened
21:17:47  #3: broadcast 70646526… for target 4545262 (anchor 4545259)
21:18:17  #3: mined at 4545263; completed, pocket data deleted
```

Each broadcast now targets the block after the tip as it stood when the rung was chosen. The remaining one to three blocks are testnet's inclusion latency, which affects any wallet's send.

All four cheats were tried against the live runner during this run:

| Attempt | Refused by | Runner output |
|---|---|---|
| Open installment 3 early | tlock (drand) | `cadence-seal: InvalidBeacon { round: 33415301 }` |
| Tamper with installment 1's amount | signature check | `pczt signer: IronwoodSign(InvalidExternalSignature)` |
| Stretch the plan: installment 2 sealed a year late | the runner's schedule check | `installment 2 releases 31536090 s after installment 1; the offer says every 90 s, give or take 45 s` |
| Rebroadcast paid installment 3 | the node | `transaction was committed to the best chain` |

The decoder at `/decode/706465269dd0…` on the app host shows 11 of 11 Cadence invariants holding.


## Webhooks and the CLI over Tor, live (2026-10-27)

A payer CLI subscribed to the public sandbox runner through Tor (`cadence subscribe --runner https://sandbox-production-1e16.up.railway.app …`). That was subscription `sub_312b987910f4597d3023`: 2 × 0.0002 TAZ, one every 90 s, with both installments mined (4,545,584 and 4,545,605). The sandbox posts its webhooks to `scripts/webhook-echo.py`, which runs as a Railway service on the project's private network with no public domain. The echo's log:

```
cadence_signature_ok=true cipherpay_signature_ok=true delivery_id="0cfa3da1-…" event={"type":"invoice.confirmed","event":"confirmed","offer_id":"off_690580b046b23da8e5ac","subscription_id":"sub_312b987910f4597d3023","k":1,…}
cadence_signature_ok=true cipherpay_signature_ok=true delivery_id="622df06a-…" event={"type":"invoice.confirmed","event":"confirmed",…,"k":2,…}
```

The runner's log for the same deliveries:

```
sub_312b987910f4597d3023 #1: webhook invoice.confirmed (0cfa3da1-b95d-4c51-8981-6d5542fde91e): delivered on attempt 1
sub_312b987910f4597d3023 #2: webhook invoice.confirmed (622df06a-2901-4b5e-8237-2d2628615962): delivered on attempt 1
```

Each delivery carried both signatures: Cadence's `X-Cadence-Signature` and CipherPay's headers, computed as CipherPay documents. The echo verified both.


## A browser cancel on the app host, live (2026-10-28)

The payer was Edge on macOS, using the app host at build `a594f3d`, with the sandbox runner.
- **Subscription:** `sub_2783c7d86a562e351b6d`, 4 × 0.001 TAZ, one every 300 s.
- **Funding:** prepaid 0.0044 TAZ in funding transaction `66d8e5d23633208c88765d4760a430b8f7772d18ca7cea460fd1ba795d03c3a9`.
- **The tab:** the payer pane was closed after signing, then reopened in the same tab to cancel.

| Block | Event |
|---|---|
| 4,549,834 | funding mined |
| 4,549,844 | installment 1 mined (`b698115d3a482889ea2b91a72b6f0321f62bd5034367ca5d02ca7de2180c1016`) |
| 4,549,861 | installment 2 mined (`a4f8a1f43e2bc61b2250b1f003c06ba61d536598572f7954e9c69e3c89a40d42`) |
| 4,549,865 | cancel mined (`75c1c91437e07f422be8df9e9929d65a3c50d566ba925ac4ca47ddc1a235d048`), spending installment 2's change |

1. **First try (05:18 UTC).** The cancel started before installment 2 opened, refunding installment 1's change. Proving took over a minute with the tab in the background. Installment 2 was broadcast first and spent that note, so the node refused the cancel.
2. **Second try.** The page re-read the pocket and waited for installment 2's change to be 3 blocks deep. It then proved the refund of that note and broadcast it at about 05:22 UTC, some 90 s before installment 3 opened.
3. **The runner's view.** It reports the subscription `cancelled`, with installments 3 and 4 `cancelled`.

**The certificate:**
- **Never valid now:** installments 3 and 4.
- **Returned:** 0.0021 TAZ to the sandbox faucet, with a fee of 0.0001 TAZ.
- **Spent nullifier:** `ea74a17223272a768a9e9cd05b04c21691e327e293e918bc2158f747b4bf2b01`.

On the app host, the decoder at `/decode/75c1c91437e0…?nf=ea74a1722327…`:
- shows 11 of 11 Cadence invariants holding;
- matches the stock-send profile on 11 of 11 fields;
- confirms that the transaction reveals the certificate's nullifier.

**Earlier attempts the same night.** These ran at 4 × 180 s, on blocks about 50 s apart. Three cancels in a row lost the note to the next installment: both wait for the same note to be 3 blocks deep, and the runner's installment was already signed. That is why the sandbox now offers a 300 s period.
