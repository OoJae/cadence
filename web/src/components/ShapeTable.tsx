import type { ReactNode } from 'react';
import type { NetworkId, Shape } from '../api/types';
import type { ShapeProfile } from '../data/stockReference';
import {
  anchorMatchesStockRule,
  blocksLate,
  BRANCHES,
  defaultExpiry,
  expectedFee,
  expiryDeltaFor,
  feeRuleName,
  impliedTarget,
  proofBytesFor,
  sameOrDiffers,
  type Comparison,
} from '../lib/shape';
import { CheckIcon, EyeIcon, EyeOffIcon, XIcon } from './Icons';
import { Badge } from './ui';

const n = (x: number) => x.toLocaleString('en-US');
const range = (a: number, b: number) => (a === b ? n(a) : `${n(a)}–${n(b)}`);
const none = <span className="faint mono">—</span>;

/** "target + 40" before NU7, "target + 120" from NU7. */
function deltaText(s: Shape): string {
  const delta = expiryDeltaFor(s.branch_id);
  return delta === null ? 'target + ?' : `target + ${delta}`;
}

interface Row {
  label: string;
  hint: string;
  /** `network` is the one the transaction was decoded from: the fee rule depends on it. */
  value: (s: Shape, network: NetworkId) => ReactNode;
  /** How this field compares with the reference column. */
  compare: (a: Shape, b: Shape) => Comparison;
  /** Can a chain observer read this field? (Everything in a Shape is public; this says whether it reveals anything about you.) */
  observer: 'visible' | 'hidden';
  observerNote: string;
}

const ROWS: Row[] = [
  {
    label: 'Version',
    hint: 'Transaction format',
    value: (s) => <span className="mono">{s.version}</span>,
    compare: (a, b) => sameOrDiffers(a.version, b.version),
    observer: 'visible',
    observerNote: 'Every new shielded send since Orchard was sealed is v6.',
  },
  {
    label: 'Consensus branch',
    hint: 'Network upgrade it was signed for',
    value: (s) => (
      <span className="mono">
        {s.branch_id}
        {BRANCHES[s.branch_id] && <span className="muted"> · {BRANCHES[s.branch_id]}</span>}
      </span>
    ),
    compare: (a, b) => sameOrDiffers(a.branch_id, b.branch_id),
    observer: 'visible',
    observerNote: 'Same for every transaction at this height.',
  },
  {
    label: 'Transparent in / out',
    hint: 'Public addresses and amounts',
    value: (s) => (
      <span className="mono">
        {s.transparent_inputs} / {s.transparent_outputs}
      </span>
    ),
    compare: (a, b) => sameOrDiffers([a.transparent_inputs, a.transparent_outputs], [b.transparent_inputs, b.transparent_outputs]),
    observer: 'hidden',
    observerNote: 'Zero transparent parts: no public address or amount anywhere.',
  },
  {
    label: 'Sapling spends / outputs',
    hint: 'Older shielded pool',
    value: (s) => (
      <span className="mono">
        {s.sapling_spends} / {s.sapling_outputs}
      </span>
    ),
    compare: (a, b) => sameOrDiffers([a.sapling_spends, a.sapling_outputs], [b.sapling_spends, b.sapling_outputs]),
    observer: 'hidden',
    observerNote: 'No cross-pool movement that could hint at amounts.',
  },
  {
    label: 'Orchard-pool actions',
    hint: 'Sealed pool (ZIP 258)',
    value: (s) => <span className="mono">{s.orchard_actions}</span>,
    compare: (a, b) => sameOrDiffers(a.orchard_actions, b.orchard_actions),
    observer: 'hidden',
    observerNote: 'Nothing moves through the sealed Orchard pool.',
  },
  {
    label: 'Ironwood actions',
    hint: 'Spend + output pairs',
    value: (s) => (
      <span className="mono">
        {s.ironwood_actions} {s.ironwood_flags != null && <span className="muted">· flags {s.ironwood_flags} (0b{s.ironwood_flags.toString(2)})</span>}
      </span>
    ),
    compare: (a, b) => sameOrDiffers([a.ironwood_actions, a.ironwood_flags], [b.ironwood_actions, b.ironwood_flags]),
    observer: 'visible',
    observerNote: 'Two actions: one payment plus change, padded, like an ordinary one-recipient send.',
  },
  {
    label: 'Fee',
    hint: 'Ironwood value balance',
    value: (s, network) => {
      if (s.ironwood_value_balance == null) return none;
      const target = impliedTarget(s);
      const standard = target !== null && s.ironwood_actions === 2 && s.ironwood_value_balance === expectedFee(s, network);
      return (
        <span className="mono">
          {n(s.ironwood_value_balance)} zats <span className="muted">{standard ? `· ${feeRuleName(network, target)} for 2 actions` : ''}</span>
        </span>
      );
    },
    compare: (a, b) => sameOrDiffers(a.ironwood_value_balance, b.ironwood_value_balance),
    observer: 'visible',
    observerNote: 'The only value that leaves the pool is the standard fee for the target height (ZIP 317; on mainnet from 3,590,000, ZIP 2009). The payment amount stays encrypted.',
  },
  {
    label: 'Expiry delta',
    hint: 'Expiry relative to target height',
    value: (s) => {
      const late = blocksLate(s);
      return s.mined_height ? (
        <span className="mono">
          {deltaText(s)}{' '}
          <span className="muted">
            · expiry − mined = {s.expiry_minus_mined}
            {late !== null && ` (${late} late)`}
          </span>
        </span>
      ) : (
        <span className="mono">
          {deltaText(s)} <span className="muted">· not mined yet</span>
        </span>
      );
    },
    compare: (a, b) => (defaultExpiry(a) === defaultExpiry(b) ? 'same' : 'differs'),
    observer: 'visible',
    observerNote: 'The default every stock wallet uses for its branch: 40 blocks before NU7, 120 from NU7. Rungs are signed per height so the runner never needs a non-default expiry.',
  },
  {
    label: 'Anchor depth range',
    hint: 'How far below the mined block the anchor sits',
    value: (s) => {
      if (!s.anchor_heights) return none;
      const heights = `${s.anchor_heights[0] === s.anchor_heights[1] ? 'height' : 'heights'} ${range(s.anchor_heights[0], s.anchor_heights[1])}`;
      return s.mined_height && s.anchor_depths ? (
        <span className="mono">
          {range(s.anchor_depths[0], s.anchor_depths[1])} blocks <span className="muted">· {heights}</span>
        </span>
      ) : (
        <span className="mono">{heights}</span>
      );
    },
    compare: (a, b) => (!a.anchor_heights || !b.anchor_heights ? 'n/a' : anchorMatchesStockRule(a) === anchorMatchesStockRule(b) ? 'same' : 'differs'),
    observer: 'visible',
    observerNote: 'Consistent with target − 3, the stock wallet rule. A stale pre-proved anchor would stand out here; Cadence proves at release time instead.',
  },
  {
    label: 'Proof size',
    hint: 'Halo 2, 2720 + 2272 × actions',
    value: (s) =>
      s.ironwood_proof_bytes == null ? (
        none
      ) : (
        <span className="mono">
          {n(s.ironwood_proof_bytes)} bytes {s.ironwood_proof_bytes === proofBytesFor(s.ironwood_actions) && <span className="muted">· standard</span>}
        </span>
      ),
    compare: (a, b) => sameOrDiffers(a.ironwood_proof_bytes, b.ironwood_proof_bytes),
    observer: 'visible',
    observerNote: 'Fixed by the action count.',
  },
  {
    label: 'Zero-OVK recoverable',
    hint: 'Outputs anyone can decrypt',
    value: (s) => (
      <span className="mono">
        {s.zero_ovk_recoverable} of {s.ironwood_actions}
      </span>
    ),
    compare: (a, b) => sameOrDiffers(a.zero_ovk_recoverable, b.zero_ovk_recoverable),
    observer: 'hidden',
    observerNote: 'No output is encrypted to the all-zero outgoing viewing key, so nobody can read recipient or amount from the ciphertext.',
  },
  {
    label: 'Pocket-OVK recoverable',
    hint: "With the pocket's external and internal OVKs",
    value: (s) => (
      <span className="mono">
        {s.supplied_ovk_recoverable} of {s.ironwood_actions}
      </span>
    ),
    compare: () => 'n/a',
    observer: 'hidden',
    observerNote: 'Every output uses OvkPolicy::Discard, so even the runner, which holds the pocket UFVK, cannot decrypt outgoing records.',
  },
  {
    label: 'Mined height',
    hint: 'Block it was mined in',
    value: (s) => <span className="mono">{s.mined_height ? n(s.mined_height) : 'mempool'}</span>,
    compare: () => 'per-tx',
    observer: 'visible',
    observerNote: 'Public for every transaction.',
  },
];

function MatchCell({ c }: { c: Comparison }) {
  if (c === 'same')
    return (
      <span className="match same">
        <CheckIcon size={13} /> same
      </span>
    );
  if (c === 'differs')
    return (
      <span className="match diff">
        <XIcon size={13} /> differs
      </span>
    );
  return <span className="match na">{c === 'per-tx' ? 'per tx' : 'n/a'}</span>;
}

/** `network` is the one the runner decoded both transactions from (testnet, where the judge sandbox runs, if not given). */
export function ShapeTable({ shape, compare, network = 'test' }: { shape: Shape; compare?: ShapeProfile | null; network?: NetworkId }) {
  const rows = ROWS;
  const comparable = compare ? rows.map((r) => r.compare(shape, compare.shape)).filter((c) => c === 'same' || c === 'differs') : [];
  const same = comparable.filter((c) => c === 'same').length;
  const target = impliedTarget(shape);
  const delta = expiryDeltaFor(shape.branch_id);

  return (
    <div className="stack" style={{ ['--gap' as string]: '12px' }}>
      {compare && (
        <div className="row small">
          <Badge tone={same === comparable.length ? 'green' : 'red'} dot>
            {same} / {comparable.length} comparable fields match
          </Badge>
          <span className="muted">against {compare.title.toLowerCase()}</span>
        </div>
      )}
      <div className="table-wrap">
        <table className="data stackable">
          <thead>
            <tr>
              <th scope="col">Field</th>
              <th scope="col">This transaction</th>
              {compare && <th scope="col">{compare.source === 'reference' ? 'Stock wallet send (reference)' : 'Compared transaction'}</th>}
              {compare && <th scope="col">Match</th>}
              <th scope="col">Chain observer</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label}>
                <td data-label="Field" className="wide">
                  <div className="h4">{r.label}</div>
                  <div className="tiny muted">{r.hint}</div>
                </td>
                <td data-label="This transaction">{r.value(shape, network)}</td>
                {compare && (
                  <td data-label={compare.source === 'reference' ? 'Stock send' : 'Compared'}>
                    {r.label === 'Pocket-OVK recoverable' ? <span className="faint mono">— no pocket key</span> : r.label === 'Mined height' && compare.source === 'reference' ? <span className="faint mono">—</span> : r.value(compare.shape, network)}
                  </td>
                )}
                {compare && (
                  <td data-label="Match">
                    <MatchCell c={r.compare(shape, compare.shape)} />
                  </td>
                )}
                <td data-label="Chain observer" className="wide">
                  <span title={r.observerNote}>
                    {r.observer === 'hidden' ? (
                      <Badge tone="green">
                        <EyeOffIcon size={12} /> reveals nothing
                      </Badge>
                    ) : (
                      <Badge tone="red">
                        <EyeIcon size={12} /> visible
                      </Badge>
                    )}
                  </span>
                  <div className="tiny muted" style={{ marginTop: 4, maxWidth: 340 }}>
                    {r.observerNote}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="tiny muted">
        {target !== null && delta !== null
          ? `Implied target height ${n(target)} (expiry − ${delta}, the ${BRANCHES[shape.branch_id]} default). `
          : `No implied target height: this app knows no default expiry delta for branch ${shape.branch_id}. `}
        Every field above is public; the badges say whether it tells an observer anything about the payer, the merchant or the amount.
      </p>
    </div>
  );
}

/** The two lists judges care about: what a chain observer can and cannot tell. */
/** `fee` is the decoded transaction's fee, when there is one to quote. */
export function ObserverSummary({ fee }: { fee?: number | null }) {
  const can = [
    ['That it is a v6 Ironwood transaction', `with 2 actions and the standard ${fee ? `${n(fee)}-zat ` : ''}fee for its height, like any one-recipient send.`],
    ['When it was mined', 'and its expiry and anchor heights, so roughly when it was built.'],
    ['That some note was spent and two were created', 'but not which note, or whose.'],
  ];
  const cannot = [
    ['Who paid, or who was paid', 'There are no transparent parts, and Ironwood notes carry no sender.'],
    ['The amount', 'Only the fee leaves the pool. The payment value is inside encrypted notes.'],
    ['That this is a subscription installment', 'Its shape matches a stock send field for field (see the comparison).'],
    ['Which installments belong together', 'Nullifiers and note commitments are unlinkable across transactions.'],
    ['The memo, or where change went', '0 outputs decrypt with the all-zero OVK, and 0 with the pocket keys the runner holds.'],
  ];
  const caveats = [
    ['Timing', 'Installments are released on a schedule. Each looks like any send, but mined times are public; do not assume timing is hidden.'],
    ['The network path', 'The first node to hear a broadcast sees where it came from. The runner broadcasts over Tor by default.'],
  ];
  return (
    <div className="grid cols-3" style={{ ['--gap' as string]: '16px' }}>
      <div className="card flat">
        <div className="row" style={{ marginBottom: 14 }}>
          <Badge tone="red" lg>
            <EyeIcon size={13} /> Observer can tell
          </Badge>
        </div>
        <ul className="observer-list">
          {can.map(([a, b]) => (
            <li key={a}>
              <EyeIcon size={15} />
              <span>
                <strong>{a}</strong> {b}
              </span>
            </li>
          ))}
        </ul>
      </div>
      <div className="card flat">
        <div className="row" style={{ marginBottom: 14 }}>
          <Badge tone="green" lg>
            <EyeOffIcon size={13} /> Observer cannot tell
          </Badge>
        </div>
        <ul className="observer-list">
          {cannot.map(([a, b]) => (
            <li key={a}>
              <EyeOffIcon size={15} />
              <span>
                <strong>{a}.</strong> {b}
              </span>
            </li>
          ))}
        </ul>
      </div>
      <div className="card flat">
        <div className="row" style={{ marginBottom: 14 }}>
          <Badge tone="amber" lg>
            Honest caveats
          </Badge>
        </div>
        <ul className="observer-list">
          {caveats.map(([a, b]) => (
            <li key={a}>
              <span className="badge tone-amber" style={{ height: 20, padding: '0 6px' }}>
                !
              </span>
              <span>
                <strong>{a}.</strong> {b}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
