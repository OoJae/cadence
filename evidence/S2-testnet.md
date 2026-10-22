# S2: chained pre-signed installments on NU7 testnet (2026-10-22)

Three installments of one mandate were pre-signed by the payer CLI, which holds the
pocket seed. They were then released by a separate runner process that imported
**only the pocket's Orchard-only UFVK**. Each installment `k` spends the change
`C(k-1)` of installment `k-1`. Installments 2 and 3 were signed before their parents
existed on chain. The runner installed each anchor (tip+1-3, checked against
lightwalletd's tree state) and witness after signing, then proved and broadcast.

| # | txid | target | mined | input | anchor set by runner |
|---|------|--------|-------|-------|----------------------|
| 1 | 7ae2c96a9ca13ba42097236766582cab0c5c4809777c966c2bdb50e46597e790 | 4529247 | 4529248 | funding note (faucet tx f7bacff4…aca1, mined 4529209) | 4529244 |
| 2 | c0daf3c1b149a260c82d44cfa1aafcba449a03c6dafd65b992ec770ee26696c2 | 4529252 | 4529255 | C(1), mined 4529248 | 4529249 |
| 3 | edad440b06c85b6570a2ca8628fa7a0f463d8d4ed914658339764d9eef3f6900 | 4529258 | 4529263 | C(2), mined 4529255 | 4529255 |

Decoded shape of every installment (`cadence-decode`, full output in
`s2-testnet-decoded.json`):

- **Format:** v6 on the NU7 testnet branch `77190ad9`, with `lock_time = 0`.
- **Pools:** 0 transparent inputs and outputs, no Sapling, no Orchard-pool actions, and exactly 2 Ironwood actions (flags 7).
- **Fee:** the Ironwood value balance is 10,000 zats, which is the ZIP 317 fee for 2 actions.
- **Expiry:** exactly target + 120, the NU7 default delta. Testnet mined these 1, 3 and 5 blocks late.
- **Outgoing ciphertexts:** 0 outputs recoverable with the all-zero OVK, and 0 with the pocket's external or internal OVK (`OvkPolicy::Discard` on every output).
