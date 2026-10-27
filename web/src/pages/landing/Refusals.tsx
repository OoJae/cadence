import { useState } from 'react';

/** The four cheats the sandbox really attempts, and the independent layer that stops each. */
const REFUSALS = [
  { label: 'Open a payment early', layer: 'drand time-lock', result: "Refused by drand. The key is drand's signature on a round that hasn't happened yet." },
  { label: 'Raise the amount', layer: 'your signature', result: 'Refused by your signature. It covers the exact amount and recipient.' },
  { label: 'Send a paid one again', layer: "the node's double-spend rule", result: 'Refused by every node. Its note is already spent.' },
  { label: 'Stretch the plan', layer: "the runner's schedule check", result: "Refused by the runner's schedule check. It only accepts packages that follow the offer you agreed to." },
] as const;

/**
 * Four toggle buttons and one status line. Class "refusal", never "cheat": the sandbox's
 * cheat cards are what the verify script drives.
 */
export function Refusals() {
  const [picked, setPicked] = useState<number | null>(null);
  const r = picked === null ? null : REFUSALS[picked];
  return (
    <div className="refusals">
      <div className="refusal-grid">
        {REFUSALS.map((x, i) => (
          <button key={x.label} type="button" className="refusal" aria-pressed={picked === i} onClick={() => setPicked(picked === i ? null : i)}>
            <span className="refusal-mark" aria-hidden="true" />
            {x.label}
          </button>
        ))}
      </div>
      <p className="refusal-status" role="status">
        {r ? (
          <span className="stamp" key={picked}>
            <span className="stamp-layer">{r.layer}</span>
            <span className="stamp-text">{r.result}</span>
          </span>
        ) : (
          <span className="refusal-idle">Pick one.</span>
        )}
      </p>
    </div>
  );
}
