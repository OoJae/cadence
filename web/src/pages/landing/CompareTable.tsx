import { CheckIcon, XIcon } from '../../components/Icons';

const yes = (t = 'Yes') => (
  <span className="yes">
    <CheckIcon size={13} /> {t}
  </span>
);
const no = (t = 'No') => (
  <span className="no">
    <XIcon size={13} /> {t}
  </span>
);

const COLS = ['Wallet send', 'Invoice per period', 'Custodial balance'] as const;

/**
 * How the options compare. Below 700 px each row becomes a card that leads with its
 * Cadence cell; data-label carries each column's name into the card.
 */
export function CompareTable() {
  const rows = [
    ['Pays while the payer is offline', no(), no(), yes(), yes()],
    ["Funds stay under the payer's key until each payment", yes(), yes(), no(), yes('Yes, in a pocket only you can spend')],
    ["Payee can't take more than agreed", yes(), yes(), <span className="meh">Depends on the custodian</span>, yes('Yes: amounts are signed')],
    ['Cancel without asking anyone', <span className="muted">n/a</span>, yes('Stop paying'), no(), yes('Spend your note')],
    ['Looks like an ordinary shielded send on chain', yes(), yes(), <span className="meh">Varies</span>, yes('Yes, on every measured field')],
  ] as const;
  return (
    <div className="compare-plate" data-reveal="rise">
      <div className="table-wrap">
        <table className="data compare-table">
          <caption>How the options compare</caption>
          <thead>
            <tr>
              <th scope="col">
                <span className="sr-only">Property</span>
              </th>
              {COLS.map((c) => (
                <th scope="col" key={c}>
                  {c}
                </th>
              ))}
              <th scope="col" className="hl">
                Cadence
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([label, ...cells]) => (
              <tr key={label}>
                <th scope="row">{label}</th>
                {cells.map((cell, i) => (
                  <td key={i} className={i === 3 ? 'hl' : undefined} data-label={i === 3 ? 'Cadence' : COLS[i]}>
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
