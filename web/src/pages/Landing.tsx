import type { ReactNode } from 'react';
import { MerchantLearns } from '../components/MerchantLearns';
import { ArrowRightIcon, CheckIcon, CubeIcon, KeyIcon, LockIcon, PenIcon, QrIcon, TabIcon, UserIcon, XIcon } from '../components/Icons';
import { Badge, Countdown } from '../components/ui';
import { useDocumentTitle } from '../hooks';
import { firstRoundAtOrAfter, roundTime } from '../lib/drand';
import { nowSecs } from '../lib/time';
import { Link } from '../router';

const LOADED = nowSecs();
const DAY = 86400;
const HERO_RUNGS = [
  { k: 1, state: 'paid' as const, note: 'Released by the runner · mined at block 4,529,248' },
  { k: 2, state: 'sealed' as const, at: roundTime(firstRoundAtOrAfter(LOADED + 29 * DAY + 6 * 3600 + 1234)) },
  { k: 3, state: 'sealed' as const, at: roundTime(firstRoundAtOrAfter(LOADED + 59 * DAY + 6 * 3600 + 1234)) },
];

function HeroCard() {
  return (
    <div className="order-card" aria-label="Example standing order">
      <div className="row between">
        <span className="kicker plain">Standing order</span>
        <Badge tone="blue" dot live>
          Active
        </Badge>
      </div>
      <div style={{ marginTop: 14 }}>
        <div className="h3">Shielded Press · monthly</div>
        <div className="mono small muted" style={{ marginTop: 4 }}>
          0.005 ZEC every 30 days × 3 · prepaid 0.0153 ZEC
        </div>
      </div>
      <div className="rungs">
        {HERO_RUNGS.map((r) => (
          <div className={`rung${r.state === 'paid' ? ' paid' : ''}`} key={r.k}>
            <span className="ico">{r.state === 'paid' ? <CubeIcon size={15} /> : <LockIcon size={15} />}</span>
            <div style={{ minWidth: 0 }}>
              <div className="h4">Installment {r.k}</div>
              <div className="tiny muted mono">
                {r.state === 'paid' ? (
                  r.note
                ) : (
                  <>
                    tlock-sealed · opens <Countdown at={r.at!} />
                  </>
                )}
              </div>
            </div>
            <Badge tone={r.state === 'paid' ? 'green' : 'sealed'}>{r.state === 'paid' ? 'Mined' : 'Sealed'}</Badge>
          </div>
        ))}
      </div>
      <hr style={{ margin: '18px 0 14px' }} />
      <div className="row small" style={{ ['--gap' as string]: '10px' }}>
        <TabIcon size={16} />
        <span className="text-2">Payer offline since signing. Nothing on their side needs to run.</span>
      </div>
    </div>
  );
}

function Lane({ title, nodes, labels, caption }: { title: string; nodes: Array<{ cls: string; icon: ReactNode; label: string }>; labels: string[]; caption: string[] }) {
  return (
    <div className="lane">
      <div className="h4">{title}</div>
      <div className="lane-labels" aria-hidden="true">
        {labels.map((l) => (
          <span key={l}>{l}</span>
        ))}
      </div>
      <div className="lane-track">
        {nodes.map((n, i) => (
          <span key={i} className={`lane-node ${n.cls}`} title={n.label} aria-label={n.label}>
            {n.icon}
          </span>
        ))}
      </div>
      <div className="lane-caption">
        {caption.map((c, i) => (
          <span key={i}>{c}</span>
        ))}
      </div>
    </div>
  );
}

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

export function Landing() {
  useDocumentTitle('');
  return (
    <>
      <section className="hero">
        <div className="container hero-grid">
          <div className="stack" style={{ ['--gap' as string]: '22px' }}>
            <span className="kicker">Shielded standing orders · Zcash Ironwood</span>
            <h1 className="h1">
              Subscribe once.
              <br />
              <em>Close the tab.</em>
            </h1>
            <p className="lede">
              Pay a subscription from your normal Zcash wallet with one QR code, then walk away. The merchant's runner releases each pre-signed installment when it falls due. It
              can't spend, redirect or enlarge them, and you cancel at any time by spending your own note.
            </p>
            <div className="row" style={{ ['--gap' as string]: '10px' }}>
              <Link to="/sandbox" className="btn primary lg">
                Try the judge sandbox <ArrowRightIcon size={16} />
              </Link>
              <Link to="/decode/7ae2c96a9ca13ba42097236766582cab0c5c4809777c966c2bdb50e46597e790" className="btn lg">
                Decode a real installment
              </Link>
            </div>
            <div className="row tiny mono muted" style={{ ['--gap' as string]: '6px 18px' }}>
              <span>v6 transactions</span>
              <span>2 Ironwood actions</span>
              <span>0 transparent</span>
              <span>0 zero-OVK recoverable</span>
            </div>
          </div>
          <HeroCard />
        </div>
      </section>

      <section className="section">
        <div className="container">
          <div className="grid cols-2" style={{ ['--gap' as string]: 'clamp(28px, 5vw, 64px)', alignItems: 'start' }}>
            <div className="section-head" style={{ marginBottom: 0 }}>
              <span className="kicker">The gap</span>
              <h2 className="h2">
                Shielded Zcash can only <em>push</em>.
              </h2>
              <div className="prose text-2">
                <p>
                  Every shielded payment needs the payer's wallet online to sign it. Invoice-per-period tools such as CipherPay make subscriptions workable by sending a fresh invoice
                  each period, which you then pay, each time. Miss one and the subscription lapses.
                </p>
                <p>
                  Paying while you're offline has meant handing your funds to someone else first. Cadence closes that gap without custody: you sign the whole schedule up front, and
                  each payment can only be released when it is due, exactly as signed.
                </p>
              </div>
            </div>
            <div className="card stack" style={{ ['--gap' as string]: '28px' }}>
              <Lane
                title="Push: invoice per period"
                labels={['Month 1', 'Month 2', 'Month 3', 'Month 4']}
                nodes={[1, 2, 3, 4].map(() => ({ cls: 'you', icon: <UserIcon size={16} />, label: 'You: open wallet, scan, pay' }))}
                caption={['you pay', 'you pay', 'you pay', 'you pay']}
              />
              <Lane
                title="Cadence: pre-authorized pull"
                labels={['Today', 'Month 1', 'Month 2', 'Month 3']}
                nodes={[
                  { cls: 'qr', icon: <QrIcon size={16} />, label: 'You: one QR, then close the tab' },
                  { cls: 'paid', icon: <CubeIcon size={16} />, label: 'Released by the runner' },
                  { cls: 'sealed', icon: <LockIcon size={16} />, label: 'Sealed until its drand round' },
                  { cls: 'sealed', icon: <LockIcon size={16} />, label: 'Sealed until its drand round' },
                ]}
                caption={['you, once', 'runner releases', 'sealed', 'sealed']}
              />
            </div>
          </div>

          <div className="card pad-0" style={{ marginTop: 32 }}>
            <div className="table-wrap">
              <table className="data compare-table">
                <thead>
                  <tr>
                    <th scope="col" />
                    <th scope="col">Wallet send</th>
                    <th scope="col">Invoice per period</th>
                    <th scope="col">Custodial balance</th>
                    <th scope="col" className="hl">
                      Cadence
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>Pays while the payer is offline</td>
                    <td>{no()}</td>
                    <td>{no()}</td>
                    <td>{yes()}</td>
                    <td className="hl">{yes()}</td>
                  </tr>
                  <tr>
                    <td>Funds stay under the payer's key until each payment</td>
                    <td>{yes()}</td>
                    <td>{yes()}</td>
                    <td>{no()}</td>
                    <td className="hl">{yes('Yes, in a pocket only you can spend')}</td>
                  </tr>
                  <tr>
                    <td>Payee can't take more than agreed</td>
                    <td>{yes()}</td>
                    <td>{yes()}</td>
                    <td>
                      <span className="meh">Depends on the custodian</span>
                    </td>
                    <td className="hl">{yes('Yes: amounts are signed')}</td>
                  </tr>
                  <tr>
                    <td>Cancel without asking anyone</td>
                    <td className="muted">n/a</td>
                    <td>{yes('Stop paying')}</td>
                    <td>{no()}</td>
                    <td className="hl">{yes('Spend your note')}</td>
                  </tr>
                  <tr>
                    <td>Looks like an ordinary shielded send on chain</td>
                    <td>{yes()}</td>
                    <td>{yes()}</td>
                    <td>
                      <span className="meh">Varies</span>
                    </td>
                    <td className="hl">{yes('Yes, on every measured field')}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="container">
          <div className="section-head">
            <span className="kicker">How it works</span>
            <h2 className="h2">Four steps, one of them yours.</h2>
          </div>
          <div className="grid cols-4">
            {[
              {
                n: '01',
                icon: <QrIcon size={18} />,
                t: 'Fund a pocket',
                d: 'Your browser makes a fresh single-use pocket and shows one ZIP 321 QR covering every installment plus fees. Pay it from Zodl, from an Ironwood balance.',
              },
              {
                n: '02',
                icon: <PenIcon size={18} />,
                t: 'Pre-sign the schedule',
                d: 'Once the payment is mined, the browser signs each installment for every candidate block height, strips what the runner does not need, then seals it: age to the runner, tlock to its drand round.',
              },
              {
                n: '03',
                icon: <TabIcon size={18} />,
                t: 'Close the tab',
                d: 'When drand publishes an installment’s round, that one package opens. The runner adds a fresh anchor, proves and broadcasts exactly what you signed, as an ordinary v6 transaction.',
              },
              {
                n: '04',
                icon: <KeyIcon size={18} />,
                t: 'Cancel any time',
                d: 'Spend your pocket note to your own address. Every later installment then spends a note that no longer exists, and no node will accept it.',
              },
            ].map((s) => (
              <div className="card step-card" key={s.n}>
                <div className="row between">
                  <span className="step-n">{s.n}</span>
                  <span className="muted">{s.icon}</span>
                </div>
                <h3 className="h3">{s.t}</h3>
                <p className="small text-2">{s.d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="section">
        <div className="container">
          <div className="grid aside" style={{ ['--gap' as string]: '24px' }}>
            <div className="stack" style={{ ['--gap' as string]: '24px' }}>
              <div className="section-head" style={{ marginBottom: 0 }}>
                <span className="kicker">Scope of trust</span>
                <h2 className="h2">The runner releases. It cannot decide.</h2>
                <p className="lede">
                  It holds sealed packages and a view-only key for one pocket. That is enough to prove and broadcast what you signed, and not enough to do anything else.
                </p>
              </div>
              <div className="grid cols-2">
                <div className="card flat">
                  <h3 className="h4" style={{ marginBottom: 12 }}>
                    The runner can
                  </h3>
                  <ul className="observer-list">
                    <li>
                      <CheckIcon size={15} className="accent" />
                      <span>Broadcast each installment you signed, once its round has passed.</span>
                    </li>
                    <li>
                      <CheckIcon size={15} className="accent" />
                      <span>See this one pocket's balance and its schedule.</span>
                    </li>
                    <li>
                      <CheckIcon size={15} className="accent" />
                      <span>Stop early: discard the packages and shred the pocket data.</span>
                    </li>
                  </ul>
                </div>
                <div className="card flat">
                  <h3 className="h4" style={{ marginBottom: 12 }}>
                    The runner cannot
                  </h3>
                  <ul className="observer-list">
                    <li>
                      <XIcon size={15} className="accent" />
                      <span>Change an amount or recipient. Your signature covers both.</span>
                    </li>
                    <li>
                      <XIcon size={15} className="accent" />
                      <span>Open an installment early. Its key is a drand signature that doesn't exist yet.</span>
                    </li>
                    <li>
                      <XIcon size={15} className="accent" />
                      <span>Spend the pocket any other way. It has no spending key.</span>
                    </li>
                    <li>
                      <XIcon size={15} className="accent" />
                      <span>Send a paid installment again, or replay one after you cancel. Its note is already spent, so it is a double-spend.</span>
                    </li>
                  </ul>
                </div>
              </div>

              <div className="card flat">
                <h3 className="h4" style={{ marginBottom: 12 }}>
                  Honest limits
                </h3>
                <ul className="observer-list small">
                  {[
                    ['Release time rests on drand.', 'Opening a package early would take a threshold of the League of Entropy’s nodes colluding. That is a strong assumption, not a trustless one.'],
                    ['The runner must be online.', 'If it misses an installment’s signed height window, the installment is marked missed, the merchant is notified, and nothing more pays. You can then cancel (or sweep the pocket) and subscribe again.'],
                    ['The runner holds this pocket’s full viewing key.', 'Proving needs it. It is scoped to one single-use pocket with no transparent or Sapling part, and deleted at the end.'],
                    ['Unscheduled upgrades need a new signature.', 'Each signature commits to the consensus branch. Known upgrades are handled: NU7 is, because each rung is signed for the branch at its own height, and fees follow ZIP 2009 at its switch height. A schedule that runs past an upgrade unknown at signing must be signed again, which is not automatic yet.'],
                    ['This web page talks to the runner directly.', 'The runner and its hosting provider see your IP address. Use Tor Browser, or the CLI, which uses Tor, if that matters.'],
                    ['Whoever serves this page serves the code that holds your pocket key.', 'The runner software cannot spend your pocket, but a merchant who serves this page could serve other code. A build served from an origin the merchant does not control, with its commit and bundle hash in the footer to check against your own build, or the CLI, avoids that.'],
                    ['Timing is public.', 'Installments land on a schedule, like any recurring payment, and Cadence adds no jitter yet. Their fields do not link them to each other, but their timing can.'],
                  ].map(([a, b]) => (
                    <li key={a}>
                      <span className="badge tone-amber" style={{ height: 20, padding: '0 6px' }}>
                        !
                      </span>
                      <span>
                        <strong>{a}</strong> {b}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
            <div className="sticky">
              <MerchantLearns />
            </div>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="container">
          <div className="card dot-grid" style={{ textAlign: 'center', padding: 'clamp(28px, 6vw, 64px) 20px' }}>
            <div className="stack" style={{ ['--gap' as string]: '16px', alignItems: 'center' }}>
              <span className="kicker">A few minutes</span>
              <h2 className="h2">Watch three installments land, then try to cheat.</h2>
              <p className="lede" style={{ marginInline: 'auto' }}>
                The sandbox creates a mandate, funds it, signs it, closes the payer's tab and lets you try to cheat: open early, tamper, rebroadcast a paid installment, stretch the plan.
              </p>
              <div className="row" style={{ justifyContent: 'center' }}>
                <Link to="/sandbox" className="btn primary lg">
                  Open the sandbox <ArrowRightIcon size={16} />
                </Link>
                <Link to="/merchant" className="btn lg">
                  Merchant dashboard
                </Link>
              </div>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
