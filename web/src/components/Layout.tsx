import { useState, type ReactNode } from 'react';
import { usePoll } from '../hooks';
import { Link } from '../router';
import { api, apiLabel, connectTargets, isMock, mockHooks } from '../runtime';
import { Logo, MoonIcon, SunIcon } from './Icons';

type Theme = 'dark' | 'light';

/** Theme lives in memory only: this app writes nothing to browser storage. */
function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'));
  const next: Theme = theme === 'dark' ? 'light' : 'dark';
  return (
    <button
      type="button"
      className="icon-btn"
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
      onClick={() => {
        document.documentElement.dataset.theme = next;
        setTheme(next);
      }}
    >
      {theme === 'dark' ? <SunIcon size={16} /> : <MoonIcon size={16} />}
    </button>
  );
}

function RunnerPill() {
  const status = usePoll((signal) => api.status(signal), 5000);
  const ok = !!status.data && !status.error;
  return (
    <span className="runner-pill" title={status.error ? status.error.message : `Runner: ${apiLabel}`}>
      <span className={`status-dot${ok ? ' ok' : status.error ? ' err' : ''}`} aria-hidden="true" />
      <span>{status.data ? (status.data.network === 'main' ? 'mainnet' : 'testnet') : '…'}</span>
      <span className="label-long faint">·</span>
      <span className="label-long">{isMock ? 'mock runner' : apiLabel}</span>
      {status.data && <span className="label-long faint num">#{status.data.tip.toLocaleString('en-US')}</span>}
    </span>
  );
}

export function Header() {
  return (
    <header className="site-header">
      <div className="container bar">
        <Link to="/" className="brand" aria-label="Cadence home">
          <Logo />
          <span className="brand-word">Cadence</span>
        </Link>
        <nav className="nav" aria-label="Main">
          <Link to="/">Overview</Link>
          <Link to="/sandbox">Judge sandbox</Link>
          <Link to="/merchant">Merchant</Link>
          <Link to="/decode">Decoder</Link>
        </nav>
        <div className="header-tools">
          <RunnerPill />
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}

export function MockBanner() {
  if (!isMock) return null;
  return (
    <div className="mock-banner" role="note">
      <div className="container">
        <span className="tag">Mock mode</span>
        <span>
          An in-page runner, a mock signer and a {mockHooks?.blockSecs ?? 5}-second-block testnet model stand in for the real ones. This page sends no network requests at all. Rows marked{' '}
          <em>evidence</em> use the real S2 testnet txids.
        </span>
      </div>
    </div>
  );
}

export function Footer() {
  return (
    <footer className="site-footer">
      <div className="container cols">
        <div className="stack" style={{ ['--gap' as string]: '10px' }}>
          <Link to="/" className="brand" aria-label="Cadence home">
            <Logo size={22} />
            <span className="brand-word" style={{ fontSize: 21 }}>
              Cadence
            </span>
          </Link>
          <p>Pre-authorized shielded standing orders on Zcash Ironwood. ZECATHON 2026, Shielded Payments track.</p>
          <p className="faint">Testnet software. Not audited. Do not use it with funds you cannot afford to lose.</p>
        </div>
        <div>
          <h4>This page</h4>
          <ul>
            <li>No analytics, trackers or crash reporting.</li>
            <li>No third-party requests: fonts and code are served from this origin.</li>
            <li>Stores nothing in your browser: no cookies, no localStorage.</li>
            <li>
              Talks to:{' '}
              <span className="mono text-2">{connectTargets.length ? connectTargets.join(', ') : 'nothing (mock mode)'}</span>
            </li>
          </ul>
        </div>
        <div>
          <h4>Explore</h4>
          <ul>
            <li>
              <Link to="/sandbox">Judge sandbox</Link>
            </li>
            <li>
              <Link to="/merchant">Merchant dashboard</Link>
            </li>
            <li>
              <Link to="/decode/7ae2c96a9ca13ba42097236766582cab0c5c4809777c966c2bdb50e46597e790">Decode a real S2 installment</Link>
            </li>
          </ul>
        </div>
      </div>
    </footer>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <Header />
      <MockBanner />
      <main id="main" tabIndex={-1}>
        {children}
      </main>
      <Footer />
    </>
  );
}
