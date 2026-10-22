import type { Installment, NetworkId } from '../api/types';
import { formatDateTime } from '../lib/time';
import { formatZec } from '../lib/zat';
import { Countdown, Round, StateBadge, Txid } from './ui';

function When({ inst }: { inst: Installment }) {
  switch (inst.state) {
    case 'sealed':
      return <Countdown at={inst.release_at} />;
    case 'due':
      return <span className="small accent">opened · waiting for anchor depth</span>;
    case 'broadcast':
      return <span className="small">in the mempool</span>;
    default:
      return <span className="small text-2 nowrap">{formatDateTime(inst.release_at)}</span>;
  }
}

function Heights({ inst }: { inst: Installment }) {
  if (!inst.target_height) return <span className="faint">—</span>;
  if (inst.state === 'missed')
    return (
      <>
        {inst.target_height.toLocaleString('en-US')} <span className="faint">· no rung</span>
      </>
    );
  return (
    <>
      {inst.target_height.toLocaleString('en-US')}
      <span className="faint"> → </span>
      {inst.mined_height ? inst.mined_height.toLocaleString('en-US') : <span className="faint">…</span>}
    </>
  );
}

export function InstallmentTable({ installments, network = 'test' }: { installments: Installment[]; network?: NetworkId }) {
  return (
    <div className="table-wrap">
      <table className="data stackable">
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">State</th>
            <th scope="col" className="r">
              Amount
            </th>
            <th scope="col">Release · drand round</th>
            <th scope="col" className="r">
              Target → mined
            </th>
            <th scope="col">Txid</th>
          </tr>
        </thead>
        <tbody>
          {installments.map((i) => (
            <tr key={i.k}>
              <td data-label="Installment" className="mono">
                {i.k}
              </td>
              <td data-label="State">
                <StateBadge state={i.state} />
              </td>
              <td data-label="Amount" className="r mono num nowrap">
                {formatZec(i.amount_zat, network)}
              </td>
              <td data-label="Release · drand round">
                <div>
                  <When inst={i} />
                </div>
                <div className="tiny faint">
                  round <Round round={i.release_round} />
                </div>
              </td>
              <td data-label="Target → mined" className="r mono num nowrap">
                <Heights inst={i} />
              </td>
              <td data-label="Txid" className="nowrap">
                {i.txid ? <Txid value={i.txid} head={6} tail={4} /> : <span className="faint mono">—</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
