# Contract v2 on testnet, before deploying (2026-10-28)

Two runs on Zcash testnet checked this build (`wave/integration`, 4e2307e and db129cc) before any of it was deployed:

- **The runner.** A runner from this build ran on a laptop: `cadence-runner serve --network test --direct --drand-direct`. It had no sandbox funder.
- **Funding.** Its pockets were funded by the deployed sandbox's faucet. Each pocket's viewing key was also registered there, so the faucet would pay it.
- **The app.** The web app came from the same build, served same-origin, with the WebAssembly signer, driven by Playwright in Chromium.
- **Where the money went.** Every payment went to the sandbox wallet, and every refund back to it.

## 1. Payer key, access pass, a merchant stop and a refund in the browser

An offer of 3 × 0.0002 TAZ every 150 s, with the merchant's fiat label `US$1.00 at US$42.10/ZEC`.

| Time (UTC) | What happened |
|---|---|
| 06:54:37 | The plan step showed "Matches the runner's copy" and the fiat label line |
| 06:54:49 | The faucet funded the pocket: `d21a21c682e3fe4fc3edd40b70f4ed2816571071fd255250104eeb4c9f9ba972` |
| 06:55:53 | The browser signed and uploaded `sub_5c87eaadf6153dc04627`; the runner stored its payer auth key |
| 06:55:53 | The release rounds were 150 s and 165 s apart: the period plus the payer's own jitter (at most 37 s here) |
| 06:55:54 | The cancel key was saved as `cadence-cancel-key-20261028-0755.age`, with no pocket id in the name, and checked |
| 06:55:54 | Access pass issued. `POST /api/passes/verify` answered `valid: true, paid: 0`, and `/pass` showed "Valid" |
| 06:58:30 | Installment 1 was mined at 4,550,102 (`612886811dd7c7fcfceed8ea7f315b95e109b5a554632bbb4121c468d254ead8`) |
| 06:58:30 | The merchant stopped the subscription: status `stopped`, `refundable: true` |
| 07:00:32 | /manage, with the cancel key: "Refund what's left", then a refund certificate. The refund `0ae53628ed694db68025ae685f50e013002c3e2421d12d80dbedd1dbc1e212b3` was mined at 4,550,106 |
| 07:00:32 | The runner recorded the refund and forgot the pocket: `refundable: false` |

The only console errors were three 400s from the witness endpoint, "not yet anchor-deep". That is the refund waiting, as designed, for the change of installment 1 to be 3 blocks deep.

## 2. Re-signing with the CLI

An offer of 3 × 0.0002 TAZ every 600 s.

```
$ cadence subscribe --runner http://127.0.0.1:8799 --offer off_ad82d7374495c7b9eae8 --out rs-sub.json --first-in 300 --direct
installment 2: rungs for heights 4550196..=4550404 (branch 77190ad9), signed at tip 4550192
installment 3: rungs for heights 4550214..=4550439 (branch 77190ad9), signed at tip 4550192
subscription sub_9e95df52ed8afaefafdd: active. You can close this now.

$ cadence resign --subscription rs-sub.json --dry-run --direct
re-signing from the funding note: 0.0009 ZEC in 9a09863ab4d191583f06995751baabb76325507e3ae0eb98335ce798014820bf
installment 1: round 33456695 as before (releases at 1793173449), 177 rungs for heights 4550193..=4550369, spends 0797738731…dd0e, sealed in 65536 bytes
installment 2: round 33456903 as before (releases at 1793174073), 209 rungs for heights 4550196..=4550404, spends e90b74c23b…6f37, sealed in 65536 bytes
installment 3: round 33457123 as before (releases at 1793174733), 226 rungs for heights 4550214..=4550439, spends 64ac97d395…6015, sealed in 65536 bytes
dry run: every package checks out; installments 1, 2, 3 of sub_9e95df52ed8afaefafdd would be replaced. Nothing was uploaded.

$ cadence resign --subscription rs-sub.json --direct
installment 1: round 33456695 as before (releases at 1793173449), 175 rungs for heights 4550194..=4550368, …
re-signed: the runner replaced installments 1, 2, 3 of sub_9e95df52ed8afaefafdd
```

**What the re-sign shows:**
- The real re-sign ran at a later tip than the dry run. So installment 1's ladder came out at 175 rungs from 4,550,194, not 177, and it really is a new package.
- Each installment kept its drand round.
- Each spends the same note as before, because the fee was the same.

**What happened next:**
- **Installment 1, from the re-signed package:** mined at 4,550,214, target 4,550,211 (`1acccc75476b6a94f0f2e827984e13a4b8d6d2c275cb1f5499294a6f820beabf`).
- **The cancel:** `cadence cancel` then returned the remaining 50,000 zats in `31055008a286a34037a7d8dc8aa4ca51d13fb2debc6cb9ef6cb2f83f9b134c98`.
  - Its first attempt stopped on "not yet anchor-deep", because installment 1's change was only a block old.
  - The CLI now waits for the note to be deep enough, as the web app does.

## 3. A bug this found, and what it affects

**The panic.** Before run 2, the first runner was restarted on its own databases. Its only pocket had been refunded and forgotten, so the wallet held no account, and its scan ranges had become Ignored. Registering the next pocket then panicked inside zcash_client_backend 0.25 (`spanning_tree.rs:285`, "Split point is within the range of to_insert"), and the scheduler stopped.

**What noticed it.** `/api/status` reported `scheduler.healthy: false`. That is the new health field, doing what it is for.

**What it affects:**
- **Runners with a sandbox funder never reach this.** Their wallet always holds the funder's account. This covers the deployed sandbox.
- **Runners without one do reach it.** This covers the mainnet runner's design, and its 7244e6a build too. They reach it after their last pocket is forgotten, which for `main` is after the weekly mandate completes on 2026-11-17.

The funds of that run were swept back with `cadence sweep` (`0a9ed346283173d62aff43b062ecba1488e68c63ad5f46f3b7f51b228ed092db`). Run 2 used fresh databases.
