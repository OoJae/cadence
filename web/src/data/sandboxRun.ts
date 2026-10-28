/**
 * The last public sandbox run, for when the faucet is too low to start another:
 * evidence/railway-sandbox.md, "A browser cancel on the app host, live (2026-10-28)".
 * Its cancel is testnet transaction `cancelTxid`, which reveals `spentNullifier`.
 */
export const LAST_SANDBOX_RUN = {
  evidenceUrl: 'https://github.com/OoJae/cadence/blob/main/evidence/railway-sandbox.md#a-browser-cancel-on-the-app-host-live-2026-10-28',
  cancelTxid: '75c1c91437e07f422be8df9e9929d65a3c50d566ba925ac4ca47ddc1a235d048',
  spentNullifier: 'ea74a17223272a768a9e9cd05b04c21691e327e293e918bc2158f747b4bf2b01',
} as const;
