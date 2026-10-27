import { Component, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { BUILD_INFO_FILE, type BuildInfo } from '../config/buildInfo';
import { usePoll } from '../hooks';
import { shorten } from '../lib/addresses';
import { Link, useLocation } from '../router';
import { api, apiLabel, apiSetting, connectTargets, isMock, loadBuildInfo, mockHooks } from '../runtime';
import { Logo, MoonIcon, SunIcon } from './Icons';
import { Callout, CopyButton } from './ui';

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
        // The switch is instant: colour transitions sit out the frame the theme changes.
        const html = document.documentElement;
        html.classList.add('theme-switch');
        html.dataset.theme = next;
        setTheme(next);
        requestAnimationFrame(() => requestAnimationFrame(() => html.classList.remove('theme-switch')));
      }}
    >
      {theme === 'dark' ? <SunIcon size={16} /> : <MoonIcon size={16} />}
    </button>
  );
}

/**
 * In an app-host build, /subscribe and /manage talk to the runner their offer or
 * cancel key names. Polling the default runner there would tell it, a different
 * merchant's runner, that this page is open, so the pill does not poll on them.
 */
function RunnerPill() {
  const { pathname } = useLocation();
  const ownRunner = apiSetting.kind === 'runners' && (pathname.startsWith('/subscribe') || pathname.startsWith('/manage'));
  return ownRunner ? (
    <span className="runner-pill" title="This page talks only to the runner its offer or cancel key names">
      <span className="status-dot" aria-hidden="true" />
      <span>the page's own runner</span>
    </span>
  ) : (
    <PolledRunnerPill />
  );
}

function PolledRunnerPill() {
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

const NAV = [
  { to: '/', label: 'Overview' },
  { to: '/sandbox', label: 'Judge sandbox' },
  { to: '/merchant', label: 'Merchant' },
  { to: '/decode', label: 'Decoder' },
  { to: '/manage', label: 'Manage' },
] as const;

export function Header() {
  const { pathname } = useLocation();
  const navRef = useRef<HTMLElement>(null);
  // Below 860 px the nav scrolls sideways: bring the current page's link into view.
  useLayoutEffect(() => {
    const nav = navRef.current;
    const link = nav?.querySelector('[aria-current="page"]');
    if (!nav || !link || nav.scrollWidth <= nav.clientWidth) return;
    const n = nav.getBoundingClientRect();
    const l = link.getBoundingClientRect();
    if (l.left >= n.left && l.right <= n.right) return;
    nav.scrollLeft += l.left - n.left - (n.width - l.width) / 2;
  }, [pathname]);
  return (
    <header className="site-header">
      <div className="container bar">
        <Link to="/" className="brand" aria-label="Cadence home">
          <Logo />
          <span className="brand-word">cadence</span>
        </Link>
        <nav className="nav" aria-label="Main" ref={navRef}>
          {NAV.map(({ to, label }) => {
            // A decoded transaction is still the decoder.
            const current = pathname === to || (to !== '/' && pathname.startsWith(`${to}/`));
            return (
              <Link key={to} to={to} aria-current={current ? 'page' : undefined}>
                {label}
                {/* The current page's underline: it glides to the next link on a page change. */}
                {current && <span className="nav-mark" aria-hidden="true" />}
              </Link>
            );
          })}
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
          An in-page runner, a mock signer and a {mockHooks?.blockSecs ?? 5}-second-block testnet model stand in for the real ones. This page requests nothing but its own static files. Rows marked{' '}
          <em>evidence</em> use the real S2 testnet txids.
        </span>
      </div>
    </div>
  );
}

/** The commit and bundle hash from this origin's build.json; nothing is checked here. */
function BuildLine() {
  const [info, setInfo] = useState<BuildInfo | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    void loadBuildInfo().then((i) => alive && setInfo(i));
    return () => {
      alive = false;
    };
  }, []);
  if (info === undefined) return null;
  if (!info) return <li>Build identity: none (this origin serves no {BUILD_INFO_FILE}).</li>;
  return (
    <li>
      Built from commit <span className="mono text-2">{info.commit ?? 'unknown'}</span>
      {info.dirty ? ' with uncommitted changes' : ''}; bundle sha256{' '}
      <span className="mono text-2" title={info.bundle_sha256}>
        {shorten(info.bundle_sha256, 12, 6)}
      </span>{' '}
      <CopyButton text={info.bundle_sha256} label="Copy bundle sha256" /> (<a href={`${import.meta.env.BASE_URL}${BUILD_INFO_FILE}`}>{BUILD_INFO_FILE}</a>).
    </li>
  );
}

export function Footer() {
  return (
    <footer className="site-footer">
      <div className="container cols">
        <div className="footer-brand">
          <Link to="/" className="brand" aria-label="Cadence home">
            <Logo size={20} />
            <span className="brand-word">cadence</span>
          </Link>
          <p>Pre-authorized shielded standing orders on Zcash Ironwood. ZECATHON 2026, Shielded Payments track.</p>
          <p className="faint">Experimental software. Not audited. Do not use it with funds you cannot afford to lose.</p>
        </div>
        <div>
          <h2>This page</h2>
          <ul>
            <li>No analytics, trackers or crash reporting.</li>
            <li>No third-party requests: fonts and code are served from this origin.</li>
            <li>Stores nothing in your browser: no cookies, no localStorage.</li>
            <li>
              Talks to:{' '}
              <span className="mono text-2" style={{ overflowWrap: 'anywhere' }}>
                {connectTargets.length ? connectTargets.join(', ') : 'nothing (mock mode)'}
              </span>
            </li>
            <BuildLine />
          </ul>
        </div>
        <nav aria-labelledby="footer-explore">
          <h2 id="footer-explore">Explore</h2>
          <ul>
            <li>
              <Link to="/sandbox">Judge sandbox</Link>
            </li>
            <li>
              <Link to="/merchant">Merchant dashboard</Link>
            </li>
            <li>
              <Link to="/manage">Cancel with your cancel key</Link>
            </li>
            <li>
              <Link to="/decode/7ae2c96a9ca13ba42097236766582cab0c5c4809777c966c2bdb50e46597e790">Decode a real S2 installment</Link>
            </li>
            <li>
              <Link to="/brand">Brand and design system</Link>
            </li>
            <li>
              <Link to="/status">Status</Link>
            </li>
            <li>
              <a href="https://github.com/OoJae/cadence">Source</a>
            </li>
          </ul>
        </nav>
      </div>
    </footer>
  );
}

/**
 * A page that throws while rendering (say, on a runner value it did not expect) shows
 * the error inside the layout, so the header, the footer and the other pages stay up.
 * "Try again" renders the page afresh; another page starts clean. The session stores
 * live outside the page components, so a /subscribe pocket key survives either.
 */
class PageBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: unknown): { error: Error } {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="page container narrow">
        <Callout kind="danger">
          <div className="stack" style={{ ['--gap' as string]: '10px' }}>
            <strong>This page stopped on an error.</strong>
            <span className="small mono" style={{ overflowWrap: 'anywhere' }}>
              {error.message || error.name}
            </span>
            <span className="small">Nothing was sent anywhere because of it. Anything this tab holds, such as a pocket key, is still in its memory.</span>
            <button type="button" className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => this.setState({ error: null })}>
              Try again
            </button>
          </div>
        </Callout>
      </div>
    );
  }
}

export function Shell({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  return (
    <>
      {/* The href serves no-JS readers. With JS, focus moves without touching the hash:
          on /subscribe the hash is the offer, and changing it would end the session. */}
      <a
        className="skip-link"
        href="#main"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById('main')?.focus();
        }}
      >
        Skip to content
      </a>
      <Header />
      <MockBanner />
      <main id="main" tabIndex={-1}>
        <PageBoundary key={pathname}>{children}</PageBoundary>
      </main>
      <Footer />
      {/* The pulled rung: router.tsx sweeps it up the screen during a page change. */}
      <div className="tip-line" aria-hidden="true" />
    </>
  );
}
