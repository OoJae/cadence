import type Lenis from 'lenis';
// The brand book's own styles ride with its lazy chunk, not every page's first paint.
import '../styles/brand.css';
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode, type RefObject } from 'react';
import type { InstallmentState } from '../api/types';
import { contrast, grade } from '../brand/contrast';
import { LadderArt, ladderGeometry } from '../brand/LadderArt';
import { Lockup, lockupBaseline, Wordmark } from '../brand/Wordmark';
import { LOCKUP, WORDMARK } from '../brand/wordmarkPaths';
import { Guilloche } from '../components/Guilloche';
import { ArrowRightIcon, CheckIcon, Logo, XIcon } from '../components/Icons';
import { Badge, StateBadge } from '../components/ui';
import { useDocumentTitle } from '../hooks';
import { BEAT_MS, DUR, EASE_REVEAL, EASE_TOGGLE, motionOk, STAGGER } from '../motion/tokens';
import { scrollToElement, useSmoothScroll } from '../motion/smoothScroll';
import { ReleaseSpecimen } from '../stage/ReleaseSpecimen';
import { fmt, MAINNET_SAMPLE, RUN1, RUN1_RELEASED_INDEX, RUN2, shortTxid } from './landing/data';

/**
 * The brand book, which is also the design system in use: every specimen below is the
 * real component or token, contrast ratios are computed from the hex values, and the type
 * sizes are read back from the stylesheet at the current window width.
 */

const SECTIONS = [
  { id: 'mark', title: 'The mark' },
  { id: 'wordmark', title: 'Wordmark and lockup' },
  { id: 'colour', title: 'Colour' },
  { id: 'type', title: 'Type' },
  { id: 'motion', title: 'Motion' },
  { id: 'components', title: 'Components' },
  { id: 'texture', title: 'Texture' },
  { id: 'downloads', title: 'Downloads' },
  { id: 'social-card', title: 'Social card' },
] as const;

type SectionId = (typeof SECTIONS)[number]['id'];

function Section({ id, rule, children }: { id: SectionId; rule: ReactNode; children: ReactNode }) {
  const index = SECTIONS.findIndex((s) => s.id === id);
  return (
    <section className="bb-section" id={id} aria-labelledby={`bb-${id}`}>
      <header className="bb-head">
        <span className="bb-index" aria-hidden="true">
          {index + 1}
        </span>
        <h2 className="bb-h2" id={`bb-${id}`}>
          {SECTIONS[index]!.title}
        </h2>
        <p className="bb-rule">{rule}</p>
      </header>
      <div className="bb-body">{children}</div>
    </section>
  );
}

function Plate({ caption, className, children }: { caption?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <figure className={className ? `bb-plate ${className}` : 'bb-plate'}>
      {children}
      {caption && <figcaption className="bb-caption">{caption}</figcaption>}
    </figure>
  );
}

/** Plays a specimen's animation on request (end state at once under reduced motion); unmounting cancels them. */
function useSpecimenMotion() {
  const running = useRef<Animation[]>([]);
  useEffect(() => {
    const list = running.current;
    return () => list.forEach((a) => a.cancel());
  }, []);
  return (el: Element | null | undefined, keyframes: Keyframe[], options: KeyframeAnimationOptions) => {
    if (!el) return;
    const ok = motionOk();
    const anim = el.animate(keyframes, { ...options, duration: ok ? options.duration : 0, delay: ok ? options.delay : 0 });
    const list = running.current;
    list.push(anim);
    if (options.fill !== 'forwards') anim.addEventListener('finish', () => list.splice(list.indexOf(anim), 1));
  };
}

// ------------------------------------------------------------ masthead

/**
 * Here the rung comes all the way out, as in the mark: clear of its ladder by 3/7 of the
 * ladder's width, the mark's rung gap to bar ratio. (The OG card keeps the spec's 24.)
 */
const MASTHEAD_PULL = 64 - 4 + Math.round((64 * 3) / 7);

function Masthead() {
  const art = useRef<HTMLDivElement>(null);
  // The one entrance on this page: the rung slides out of its slot, once.
  useEffect(() => {
    const rung = art.current?.querySelector('.ladder-art-released');
    if (!rung || !motionOk()) return;
    const a = rung.animate([{ transform: `translateX(${MASTHEAD_PULL}px)` }, { transform: 'none' }], {
      duration: DUR.moment,
      delay: 500,
      easing: EASE_REVEAL,
      fill: 'backwards',
    });
    return () => a.cancel();
  }, []);
  return (
    <header className="bb-masthead">
      <div className="bb-masthead-text">
        <p className="kicker">Brand book</p>
        <h1 className="bb-title">
          The pulled <em>rung</em>
        </h1>
        <p className="bb-lede">
          Your browser signs each payment once for every block it could land in: one rung each. When its round arrives, exactly one goes out, and the rest
          can never be used. That one rung, in Zcash amber, is the whole identity.
        </p>
        <p className="bb-note">
          Sizes, curves and contrast ratios here are measured live. Every figure in a specimen is real, from Cadence’s testnet runs and its mainnet sample.
        </p>
      </div>
      <figure className="bb-masthead-art" ref={art}>
        <LadderArt
          snap
          pull={MASTHEAD_PULL}
          className="bb-ladders"
          title={`Testnet run 1: ladders of ${RUN1.rungs.join(', ')} rungs, with one rung pulled out in amber`}
        />
        <figcaption className="bb-caption">
          Testnet run 1 · {RUN1.date} · {RUN1.rungs.join(' / ')} rungs, one block to a rung. The amber one is block {fmt(RUN1.mined[0])}.
        </figcaption>
      </figure>
    </header>
  );
}

function Contents({ lenis }: { lenis: RefObject<Lenis | null> }) {
  // Through Lenis, not the browser's jump: a wheel ease still running would carry the page
  // on past a native jump. The hash still records the section, for sharing and Back.
  const go = (e: MouseEvent<HTMLAnchorElement>, id: string) => {
    const el = document.getElementById(id);
    if (!el || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    history.pushState(history.state, '', `#${id}`);
    scrollToElement(el, lenis.current);
  };
  return (
    <nav className="bb-contents" aria-label="Brand book">
      <ol>
        {SECTIONS.map((s, i) => (
          <li key={s.id}>
            <a href={`#${s.id}`} onClick={(e) => go(e, s.id)}>
              <span className="bb-contents-n" aria-hidden="true">
                {i + 1}
              </span>
              {s.title}
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}

// ------------------------------------------------------------ 1 mark

/** The construction drawing's viewBox: the 48 grid plus its 11-unit clear space. */
const VB = { x: -10, y: -6, w: 68, h: 62 };
const at = (x: number, y: number) => ({ left: `${((x - VB.x) / VB.w) * 100}%`, top: `${((y - VB.y) / VB.h) * 100}%` });

function DimH({ x1, x2, y }: { x1: number; x2: number; y: number }) {
  return <path d={`M${x1} ${y}H${x2}M${x1} ${y - 0.9}v1.8M${x2} ${y - 0.9}v1.8`} />;
}
function DimV({ x, y1, y2 }: { x: number; y1: number; y2: number }) {
  return <path d={`M${x} ${y1}V${y2}M${x - 0.9} ${y1}h1.8M${x - 0.9} ${y2}h1.8`} />;
}

function Construction() {
  let grid = '';
  for (let i = 0; i < 48; i++) grid += `M${i + 0.5} 0V48`;
  for (let i = 0; i <= 48; i++) grid += `M0 ${i}H48`;
  const labels: Array<[string, number, number]> = [
    ['7', 40, 2.6],
    ['4', 34.5, 2.6],
    ['3', 13, 37.4],
    ['3', -0.4, 30.5],
    ['39', 24, 46.6],
    ['32', 50.6, 24],
    ['11', -1, 17.4],
    ['11', 10.6, 2.6],
  ];
  return (
    <div className="bb-construction">
      <svg viewBox={`${VB.x} ${VB.y} ${VB.w} ${VB.h}`} aria-hidden="true" focusable="false">
        <path className="bb-grid" d={grid} />
        <rect className="bb-grid-box" x="0" y="0" width="48" height="48" />
        <rect className="bb-clear" x="-6.5" y="-3" width="61" height="54" />
        <path fill="var(--text)" d="M14.5 8h7v21h-7zM14.5 32h7v8h-7zM25.5 8h7v32h-7zM36.5 8h7v32h-7z" />
        <rect x="4.5" y="29" width="7" height="3" fill="var(--accent-graphic)" />
        <g className="bb-dims">
          <DimH x1={36.5} x2={43.5} y={5} />
          <DimH x1={32.5} x2={36.5} y={5} />
          <DimH x1={11.5} x2={14.5} y={35} />
          <DimV x={2.4} y1={29} y2={32} />
          <DimH x1={4.5} x2={43.5} y={44} />
          <DimV x={47} y1={8} y2={40} />
          <DimH x1={-6.5} x2={4.5} y={20} />
          <DimV x={8.5} y1={-3} y2={8} />
        </g>
      </svg>
      {labels.map(([text, x, y], i) => (
        <span key={i} className="bb-dim" style={at(x, y)} aria-hidden="true">
          {text}
        </span>
      ))}
    </div>
  );
}

const SIZES = [96, 48, 32, 24, 16];
/** The lockup's size prop for a lockup this many px tall. */
const lockupForHeight = (h: number) => (h * WORDMARK.em) / LOCKUP.height;

function MarkSection() {
  return (
    <Section id="mark" rule="Three bars, and the rung pulled clear of the first. Square corners, always.">
      <Plate
        className="bb-plate-construction"
        caption={
          <dl className="bb-legend">
            <div>
              <dt>Grid</dt>
              <dd>48</dd>
            </div>
            <div>
              <dt>Bar</dt>
              <dd>7</dd>
            </div>
            <div>
              <dt>Gap</dt>
              <dd>4</dd>
            </div>
            <div>
              <dt>Rung gap</dt>
              <dd>3</dd>
            </div>
            <div>
              <dt>Slot and rung</dt>
              <dd>3</dd>
            </div>
            <div>
              <dt>Extent</dt>
              <dd>39 × 32</dd>
            </div>
            <div>
              <dt>Clear space</dt>
              <dd>11</dd>
            </div>
          </dl>
        }
      >
        <Construction />
      </Plate>

      <div className="bb-pair">
        {(['vault', 'paper'] as const).map((tone) => (
          <Plate key={tone} className={`bb-tile plate-${tone}`} caption={tone === 'vault' ? 'On Vault' : 'On Paper'}>
            <div className="bb-sizes">
              {SIZES.map((s) => (
                <div key={s} className="bb-size">
                  <Logo size={s} />
                  <span className="bb-size-label">{s}</span>
                </div>
              ))}
            </div>
            <div className="bb-minimum">
              <Lockup size={lockupForHeight(24)} />
              <span className="bb-size-label">Smallest: 16 px mark, 24 px lockup</span>
            </div>
          </Plate>
        ))}
      </div>

      <div className="bb-icons plate-paper">
        <figure className="bb-icon">
          <span className="bb-icon-row">
            {[64, 32, 16].map((s) => (
              <img key={s} src="/favicon.svg" width={s} height={s} alt="" />
            ))}
          </span>
          <figcaption className="bb-caption">Favicon, on a 32 grid: every part stays at least 2 px wide at 16 px.</figcaption>
        </figure>
        <figure className="bb-icon">
          <span className="bb-icon-row">
            {[128, 64].map((s) => (
              <img key={s} src="/brand-assets/app-icon.svg" width={s} height={s} alt="" />
            ))}
          </span>
          <figcaption className="bb-caption">App icon: the mark at 300 on a 512 Vault tile with a 112 radius.</figcaption>
        </figure>
      </div>

      <ul className="bb-rules">
        <li>Keep 11 units clear on every side: one bar and a gap.</li>
        <li>Never smaller than 16 px. The lockup is never shorter than 24 px.</li>
        <li>Bars in Ledger or Ink, the rung in Release. Recolour neither one on its own.</li>
      </ul>
    </Section>
  );
}

// ------------------------------------------------------------ 2 wordmark

const pctY = (y: number, h: number) => `${(y / h) * 100}%`;
const pctX = (x: number, w: number) => `${(x / w) * 100}%`;

function WordmarkSection() {
  const markRight = (39 * LOCKUP.mark.scale) / LOCKUP.width;
  const ascEm = WORDMARK.ascender / WORDMARK.em;
  return (
    <Section id="wordmark" rule="Lowercase Bodoni italic, read like a performance direction on a score.">
      <Plate
        className="bb-plate-wordmark"
        caption="Outlined from Bodoni Moda Italic at optical size 96, weight 500, tracked −0.005em. These are the paths in every file."
      >
        <div className="bb-guided">
          <Wordmark className="bb-wordmark-big" label="cadence" />
          <span className="bb-guide" style={{ top: pctY(WORDMARK.baseline - WORDMARK.ascender, WORDMARK.height) }} aria-hidden="true">
            <span className="bb-guide-label">Ascender of the d · {ascEm.toFixed(2)} em</span>
          </span>
          <span className="bb-guide" style={{ top: pctY(WORDMARK.baseline, WORDMARK.height) }} aria-hidden="true">
            <span className="bb-guide-label below">Baseline</span>
          </span>
        </div>
      </Plate>

      <Plate className="bb-plate-lockup" caption="The mark stands as tall as the d, its bars on the baseline, then a gap of 0.35 of its height.">
        <div className="bb-guided">
          <Lockup className="bb-lockup-big" label="Cadence lockup" />
          <span className="bb-guide" style={{ top: '0%' }} aria-hidden="true">
            <span className="bb-guide-label">Top of the mark, top of the d</span>
          </span>
          <span className="bb-guide" style={{ top: pctY(LOCKUP.baseline, LOCKUP.height) }} aria-hidden="true">
            <span className="bb-guide-label below">The bars stand on the baseline</span>
          </span>
          <span className="bb-span" style={{ left: pctX(markRight * LOCKUP.width, LOCKUP.width), width: pctX(LOCKUP.wordX - markRight * LOCKUP.width, LOCKUP.width) }} aria-hidden="true">
            <span className="bb-span-label">0.35</span>
          </span>
        </div>
      </Plate>

      <div className="bb-pair">
        {(['vault', 'paper'] as const).map((tone) => (
          <Plate key={tone} className={`bb-tile plate-${tone} bb-tile-lockup`} caption={tone === 'vault' ? 'lockup.svg' : 'lockup-light.svg'}>
            <Lockup size={44} />
          </Plate>
        ))}
      </div>

      <ul className="bb-rules">
        <li>Use the outlined files. Only the site header and footer set the name as live text, beside the mark.</li>
        <li>Always lowercase, always italic. Never retype it in another face, and never stretch, slant or space it.</li>
      </ul>
    </Section>
  );
}

// ------------------------------------------------------------ 3 colour

const HEX = {
  Vault: '#0B0D0C',
  Hairline: '#2B322E',
  Graphite: '#8B8F87',
  Ledger: '#ECEAE3',
  Release: '#F4B728',
  Paper: '#F3F0E8',
  Ink: '#171917',
} as const;
type Named = keyof typeof HEX;

interface Pair {
  fg: string;
  bg: string;
  label: string;
}

const pair = (fg: Named, bg: Named, label = `${fg} on ${bg}`): Pair => ({ fg: HEX[fg], bg: HEX[bg], label });

const SWATCHES: Array<{ name: Named; role: string; ink: Named; pairs: Pair[] }> = [
  { name: 'Vault', role: 'The dark ground: sealed time. Also the ink on Release.', ink: 'Ledger', pairs: [pair('Vault', 'Release')] },
  { name: 'Hairline', role: 'Rules and seal edges. Decorative, so never text.', ink: 'Ledger', pairs: [pair('Hairline', 'Vault')] },
  { name: 'Graphite', role: 'Secondary text, and rungs that can never be used.', ink: 'Vault', pairs: [pair('Graphite', 'Vault')] },
  { name: 'Ledger', role: 'Text, sealed rungs and the bars of the mark.', ink: 'Vault', pairs: [pair('Ledger', 'Vault')] },
  { name: 'Release', role: 'Only what happens next: the next rung, your next action, focus and “due”.', ink: 'Vault', pairs: [pair('Release', 'Vault')] },
  { name: 'Paper', role: 'The light ground, and certificate stock in both themes.', ink: 'Ink', pairs: [pair('Ink', 'Paper')] },
];

const LIGHT: Array<{ name: string; hex: string; role: string }> = [
  { name: 'Ink', hex: HEX.Ink, role: 'Text' },
  { name: 'Secondary', hex: '#5F635D', role: 'Secondary text' },
  { name: 'Release text', hex: '#8A5B00', role: 'Release as text and focus' },
  { name: 'Release graphic', hex: '#B07800', role: 'Release as a rung or a fill edge' },
];

const TONES: Array<{ name: string; dark: string; light: string; role: string }> = [
  { name: 'Settled', dark: '#55C78F', light: '#147044', role: 'Mined' },
  { name: 'Refused', dark: '#F2735F', light: '#AF3725', role: 'Missed, invalid, rejected' },
];

function Ratio({ fg, bg }: { fg: string; bg: string }) {
  const r = contrast(fg, bg);
  return (
    <span className="bb-ratio">
      <span className="mono num">{r.toFixed(1)}:1</span>
      <span className="bb-grade">{grade(r)}</span>
    </span>
  );
}

function ColourSection() {
  return (
    <Section id="colour" rule="Six colours, one job each. Release marks only what happens next.">
      <ul className="bb-swatches">
        {SWATCHES.map((s) => (
          <li key={s.name} className="bb-swatch">
            <div className="bb-chip" style={{ background: HEX[s.name], color: HEX[s.ink] }}>
              <span className="bb-chip-name">{s.name}</span>
            </div>
            <div className="bb-swatch-meta">
              <p className="bb-hex mono">{HEX[s.name]}</p>
              <p className="bb-role">{s.role}</p>
              <ul className="bb-pairs">
                {s.pairs.map((p) => (
                  <li key={p.label}>
                    <span className="bb-pair-chip" style={{ background: p.bg, color: p.fg }} aria-hidden="true">
                      Aa
                    </span>
                    <span className="bb-pair-label">{p.label}</span>
                    <Ratio fg={p.fg} bg={p.bg} />
                  </li>
                ))}
              </ul>
            </div>
          </li>
        ))}
      </ul>

      <div className="bb-dodont">
        <figure className="bb-do">
          <div className="bb-mini">
            <p className="bb-mini-title">A three-payment plan</p>
            <ol>
              <li>
                <span>Installment 1</span>
                <StateBadge state="mined" />
              </li>
              <li>
                <span>Installment 2</span>
                <StateBadge state="mined" />
              </li>
              <li>
                <span>Installment 3</span>
                <StateBadge state="due" />
              </li>
            </ol>
          </div>
          <figcaption className="bb-verdict">
            <CheckIcon size={14} /> <strong>Do:</strong> Release on the one thing that happens next.
          </figcaption>
        </figure>
        <figure className="bb-dont">
          <div className="bb-mini">
            <p className="bb-mini-title">
              A three-payment <em>plan</em>
            </p>
            <ol>
              <li>
                <span>Installment 1</span>
                <Badge tone="amber">Mined</Badge>
              </li>
              <li>
                <span>Installment 2</span>
                <Badge tone="amber">Mined</Badge>
              </li>
              <li>
                <span>Installment 3</span>
                <Badge tone="amber">Due</Badge>
              </li>
            </ol>
          </div>
          <figcaption className="bb-verdict">
            <XIcon size={14} /> <strong>Don’t:</strong> amber on the past, or for emphasis. When everything is next, nothing is.
          </figcaption>
        </figure>
      </div>

      <div className="bb-subgrid">
        <div>
          <h3 className="bb-h3">The light theme</h3>
          <p className="bb-sub">Mappings onto Paper, not new colours.</p>
          <ul className="bb-list">
            {LIGHT.map((c) => (
              <li key={c.name}>
                <span className="bb-dot" style={{ background: c.hex }} aria-hidden="true" />
                <span className="bb-list-name">{c.name}</span>
                <span className="mono bb-list-hex">{c.hex}</span>
                <Ratio fg={c.hex} bg={HEX.Paper} />
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h3 className="bb-h3">Data tones</h3>
          <p className="bb-sub">For the app’s states only. They sit outside the brand and never appear in the landing's story.</p>
          <ul className="bb-list">
            {TONES.map((t) => (
              <li key={t.name} className="bb-tone">
                <span className="bb-list-name">
                  {t.name} <span className="muted">· {t.role}</span>
                </span>
                {(
                  [
                    ['On Vault', t.dark, HEX.Vault],
                    ['On Paper', t.light, HEX.Paper],
                  ] as const
                ).map(([on, fg, bg]) => (
                  <span key={on} className="bb-tone-row">
                    <span className="bb-dot" style={{ background: fg }} aria-hidden="true" />
                    <span className="bb-tone-on">{on}</span>
                    <span className="mono bb-list-hex">{fg}</span>
                    <Ratio fg={fg} bg={bg} />
                  </span>
                ))}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Section>
  );
}

// ------------------------------------------------------------ 4 type

const SCALE: Array<{ token: string; face: 'display' | 'sans' | 'mono'; use: string; sample: ReactNode; className?: string }> = [
  { token: '--fs-hero', face: 'display', use: 'Landing hero', sample: 'Subscribe once.' },
  { token: '--fs-d1', face: 'display', use: 'Landing headings', sample: <em>Close the tab.</em> },
  { token: '--fs-d2', face: 'display', use: 'Page titles', sample: 'Cancel without asking anyone.' },
  { token: '--fs-figure', face: 'mono', use: 'Figures', sample: `${MAINNET_SAMPLE.sameShape} / ${MAINNET_SAMPLE.total}`, className: 'bb-figure' },
  { token: '--fs-title', face: 'sans', use: 'Card titles', sample: 'Every payment, signed before you go', className: 'bb-title-sample' },
  { token: '--fs-lede', face: 'sans', use: 'Ledes', sample: 'Pay once from Zodl with a single QR code.' },
  { token: '--fs-body', face: 'sans', use: 'Body, here and on the landing', sample: 'Each payment is sealed to the merchant’s runner and time-locked to a drand round.' },
  { token: '--fs-small', face: 'sans', use: 'Notes', sample: `A new round every ${BEAT_MS / 1000} seconds.` },
  { token: '--fs-label', face: 'mono', use: 'Labels, in capitals', sample: `drand round ${fmt(RUN1.rounds[0])}`, className: 'bb-label-sample' },
];

const FACES = [
  { face: 'display', name: 'Bodoni Moda', glyphs: 'Aa', role: 'Display: headlines and every italic', axes: 'Optical size 6–96 · weight 400–900' },
  { face: 'sans', name: 'Inter', glyphs: 'Aa', role: 'Text and interface', axes: 'Weight 100–900' },
  { face: 'mono', name: 'JetBrains Mono', glyphs: '0x', role: 'Figures: a value you can check', axes: 'Tabular figures · slashed zero' },
] as const;

interface Readout {
  width: number;
  sizes: Record<string, { formula: string; px: number }>;
}

function TypeSection() {
  const scale = useRef<HTMLDivElement>(null);
  const bodoni = useRef<HTMLSpanElement>(null);
  const georgia = useRef<HTMLSpanElement>(null);
  const [readout, setReadout] = useState<Readout | null>(null);
  const [fallback, setFallback] = useState<number | null | undefined>(undefined);

  // The fluid sizes as the stylesheet resolves them right now.
  useEffect(() => {
    const root = scale.current;
    if (!root) return;
    let frame = 0;
    const read = () => {
      frame = 0;
      const css = getComputedStyle(document.documentElement);
      const sizes: Readout['sizes'] = {};
      root.querySelectorAll<HTMLElement>('[data-fs]').forEach((el) => {
        const token = el.dataset.fs!;
        sizes[token] = { formula: css.getPropertyValue(token).trim(), px: parseFloat(getComputedStyle(el).fontSize) };
      });
      setReadout({ width: window.innerWidth, sizes });
    };
    const onResize = () => {
      if (!frame) frame = requestAnimationFrame(read);
    };
    read();
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  // How close the Georgia stand-in comes to Bodoni's measure on this device.
  useEffect(() => {
    let alive = true;
    let face: FontFace | undefined;
    document.fonts.forEach((f) => {
      if (f.family.replace(/["']/g, '') === 'Bodoni Fallback' && f.style === 'normal') face = f;
    });
    void Promise.allSettled([document.fonts.load('400 48px "Bodoni Moda Variable"'), face?.load()]).then(() => {
      if (!alive || !bodoni.current || !georgia.current) return;
      if (face?.status !== 'loaded') return setFallback(null);
      setFallback(georgia.current.getBoundingClientRect().width / bodoni.current.getBoundingClientRect().width);
    });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <Section id="type" rule="Three faces, one role each. Bodoni is built like the object: heavy verticals, hairline horizontals.">
      <ul className="bb-faces">
        {FACES.map((f) => (
          <li key={f.name} className="bb-face">
            <span className={`bb-face-glyphs face-${f.face}`} aria-hidden="true">
              {f.glyphs}
            </span>
            <h3 className="bb-h3">{f.name}</h3>
            <p className="bb-role">{f.role}</p>
            <p className="bb-axes mono">{f.axes}</p>
          </li>
        ))}
      </ul>

      <div className="bb-scale" ref={scale}>
        <p className="bb-scale-head mono">
          Read from the stylesheet at your window width of <span className="num">{readout ? readout.width : '…'}</span> px
        </p>
        {SCALE.map((s) => {
          const r = readout?.sizes[s.token];
          return (
            <div key={s.token} className="bb-scale-row">
              <dl className="bb-scale-meta">
                <dt className="mono">{s.token}</dt>
                <dd className="bb-scale-use">{s.use}</dd>
                <dd className="bb-scale-px mono num">{r ? `${Math.round(r.px * 10) / 10} px` : '…'}</dd>
                <dd className="bb-scale-formula mono">{r?.formula ?? ''}</dd>
              </dl>
              <p className={`bb-sample face-${s.face}${s.className ? ` ${s.className}` : ''}`} data-fs={s.token} style={{ fontSize: `var(${s.token})` }}>
                {s.sample}
              </p>
            </div>
          );
        })}
      </div>

      <p className="bb-fallback">
        <span className="bb-measure face-display" ref={bodoni} aria-hidden="true">
          Subscribe once. Close the tab.
        </span>
        <span className="bb-measure bb-measure-fallback" ref={georgia} aria-hidden="true">
          Subscribe once. Close the tab.
        </span>
        {fallback === undefined
          ? 'Measuring the stand-in face…'
          : fallback === null
            ? 'Before Bodoni arrives, a metric-matched Georgia stands in. This device has no Georgia, so it falls back to its default serif.'
            : `Before Bodoni arrives, a metric-matched Georgia stands in. On this device it sets a line at ${(fallback * 100).toFixed(1)}% of Bodoni’s width.`}
      </p>
    </Section>
  );
}

// ------------------------------------------------------------ 5 motion

const bezierOf = (ease: string): [number, number, number, number] => {
  const n = ease.match(/-?[\d.]+/g)?.map(Number) ?? [];
  if (n.length !== 4) throw new Error(`not a cubic-bezier: ${ease}`);
  return [n[0]!, n[1]!, n[2]!, n[3]!];
};

/** Curve plots: the unit box at 0-100 inside this viewBox. */
const PLOT = { pad: 8, size: 116 };

function Curve({ name, token, ease, use }: { name: string; token: string; ease: string; use: string }) {
  const [x1, y1, x2, y2] = bezierOf(ease);
  const x = useRef<HTMLDivElement>(null);
  const y = useRef<HTMLDivElement>(null);
  const run = useSpecimenMotion();
  const points = Array.from({ length: 65 }, (_, i) => {
    const t = i / 64;
    const u = 1 - t;
    const bx = 3 * u * u * t * x1 + 3 * u * t * t * x2 + t ** 3;
    const by = 3 * u * u * t * y1 + 3 * u * t * t * y2 + t ** 3;
    return `${(bx * 100).toFixed(2)},${(100 - by * 100).toFixed(2)}`;
  }).join(' ');
  const p1 = [x1 * 100, 100 - y1 * 100] as const;
  const p2 = [x2 * 100, 100 - y2 * 100] as const;
  const inset = `${(PLOT.pad / PLOT.size) * 100}%`;
  const play = () => {
    // Time runs left to right at a constant rate; progress rises with the curve.
    const opts = { duration: DUR.revealLong, fill: 'forwards' as const };
    run(x.current, [{ transform: 'translateX(0)' }, { transform: 'translateX(100%)' }], { ...opts, easing: 'linear' });
    run(y.current, [{ transform: 'translateY(0)' }, { transform: 'translateY(-100%)' }], { ...opts, easing: ease });
  };
  return (
    <figure className="bb-curve">
      <div className="bb-plot">
        <svg viewBox={`${-PLOT.pad} ${-PLOT.pad} ${PLOT.size} ${PLOT.size}`} aria-hidden="true" focusable="false">
          <rect className="bb-plot-box" x="0" y="0" width="100" height="100" />
          <path className="bb-plot-linear" d="M0 100L100 0" />
          <path className="bb-plot-handle" d={`M0 100L${p1[0]} ${p1[1]}M100 0L${p2[0]} ${p2[1]}`} />
          <polyline className="bb-plot-curve" points={points} />
          <rect className="bb-plot-cp" x={p1[0] - 1.6} y={p1[1] - 1.6} width="3.2" height="3.2" />
          <rect className="bb-plot-cp" x={p2[0] - 1.6} y={p2[1] - 1.6} width="3.2" height="3.2" />
        </svg>
        <div className="bb-tracer" style={{ inset }} aria-hidden="true">
          <div className="bb-tracer-x" ref={x}>
            <div className="bb-tracer-y" ref={y}>
              <span className="bb-tracer-dot" />
            </div>
          </div>
        </div>
      </div>
      <figcaption>
        <span className="bb-curve-name">{name}</span>
        <span className="mono bb-curve-token">
          {token}: {ease}
        </span>
        <span className="bb-curve-use">{use}</span>
        <button type="button" className="btn sm" onClick={play} aria-label={`Play the ${name.toLowerCase()} curve`}>
          Play
        </button>
      </figcaption>
    </figure>
  );
}

const DURATIONS: Array<{ token: string; ms: number; use: string }> = [
  { token: '--dur-press', ms: DUR.press, use: 'A button press' },
  { token: '--dur-micro', ms: DUR.micro, use: 'Hover and colour changes' },
  { token: '--dur-page-out', ms: DUR.pageOut, use: 'The old page leaving' },
  { token: '--dur-roll', ms: DUR.roll, use: 'Digit rolls, stamps, the click hairline' },
  { token: '--dur-reveal', ms: DUR.reveal, use: 'Line reveals' },
  { token: '--dur-page', ms: DUR.page, use: 'The new page arriving' },
  { token: '--dur-reveal-l', ms: DUR.revealLong, use: 'Long reveals' },
  { token: '--dur-camera', ms: DUR.camera, use: 'The stage camera' },
  { token: '--dur-moment', ms: DUR.moment, use: 'The release: the one orchestrated moment' },
];
const STAGGERS: Array<{ token: string; ms: number; use: string }> = [
  { token: '--stagger-tight', ms: STAGGER.tight, use: 'Band to band in the release’s cascade' },
  { token: '--stagger', ms: STAGGER.base, use: 'Line to line in a headline or caption' },
  { token: '--stagger-loose', ms: STAGGER.loose, use: 'Block to block' },
];

function PressDemo() {
  const btn = useRef<HTMLButtonElement>(null);
  const run = useSpecimenMotion();
  const play = () => {
    const el = btn.current;
    run(el, [{ transform: 'none' }, { transform: 'translateY(1px) scale(0.98)' }, { transform: 'none' }], { duration: DUR.press * 2, easing: EASE_TOGGLE });
    try {
      run(el, [{ transform: 'scaleX(0)', opacity: 1 }, { transform: 'scaleX(1)', opacity: 1, offset: 0.6 }, { transform: 'scaleX(1)', opacity: 0 }], {
        duration: DUR.roll,
        easing: EASE_TOGGLE,
        pseudoElement: '::after',
      });
    } catch {
      // No pseudo-element animation here: the press alone still shows.
    }
  };
  return (
    <figure className="bb-demo">
      <div className="bb-demo-stage">
        <button type="button" className="btn primary" ref={btn}>
          Sign and seal
        </button>
      </div>
      <figcaption>
        <span className="bb-curve-name">Press</span>
        <span className="bb-curve-use">
          Down 1 px and to 98% in {DUR.press} ms on the toggle curve, with a 1 px hairline drawn under the label.
        </span>
        <button type="button" className="btn sm" onClick={play} aria-label="Play the press">
          Play
        </button>
      </figcaption>
    </figure>
  );
}

function RevealDemo() {
  const box = useRef<HTMLDivElement>(null);
  const run = useSpecimenMotion();
  const play = () => {
    box.current?.querySelectorAll('.bb-line').forEach((el, i) =>
      run(el, [{ transform: 'translateY(110%)' }, { transform: 'none' }], { duration: DUR.reveal, delay: i * STAGGER.base, easing: EASE_REVEAL, fill: 'backwards' }),
    );
  };
  return (
    <figure className="bb-demo">
      <div className="bb-demo-stage bb-reveal" ref={box}>
        <span className="bb-mask">
          <span className="bb-line">Subscribe once.</span>
        </span>
        <span className="bb-mask">
          <span className="bb-line">
            <em>Close the tab.</em>
          </span>
        </span>
      </div>
      <figcaption>
        <span className="bb-curve-name">Line reveal</span>
        <span className="bb-curve-use">
          Each line rises out of its own mask in {DUR.reveal} ms on the reveal curve, {STAGGER.base} ms apart. Nothing is hidden until it plays.
        </span>
        <button type="button" className="btn sm" onClick={play} aria-label="Play the line reveal">
          Play
        </button>
      </figcaption>
    </figure>
  );
}

function MotionSection() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const q = matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => setReduced(q.matches);
    sync();
    q.addEventListener('change', sync);
    return () => q.removeEventListener('change', sync);
  }, []);
  return (
    <Section id="motion" rule="Things settle; they never bounce. Only transform and opacity move, and the clock is the only rhythm.">
      {reduced && <p className="bb-note">Your device asks for reduced motion, so every demo here jumps straight to its end state.</p>}
      <div className="bb-curves">
        <Curve name="Reveal" token="--ease-reveal" ease={EASE_REVEAL} use="Reveals, entrances and the camera: quick to start, long to settle." />
        <Curve name="Toggle" token="--ease-toggle" ease={EASE_TOGGLE} use="Toggles, presses and rolls: even in, even out." />
      </div>

      <div className="bb-scroll" role="region" aria-label="Durations" tabIndex={0}>
        <table className="bb-durations">
          <caption className="bb-caption">Durations, from motion/tokens.ts and the stylesheet</caption>
          <thead>
            <tr>
              <th scope="col">Token</th>
              <th scope="col">Time</th>
              <th scope="col">Used for</th>
              <th scope="col" className="bb-bar-col">
                <span className="sr-only">Length</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {[...DURATIONS, ...STAGGERS, { token: '--beat', ms: BEAT_MS, use: 'A drand round: the only thing that repeats' }].map((d) => (
              <tr key={d.token}>
                <th scope="row" className="mono">
                  {d.token}
                </th>
                <td className="mono num">{d.ms} ms</td>
                <td>{d.use}</td>
                <td className="bb-bar-col">
                  {/* To scale against the 1.4 s moment; the beat, more than twice as long, gets none. */}
                  {d.ms <= DUR.moment && <span className="bb-bar" style={{ width: `${(d.ms / DUR.moment) * 100}%` }} aria-hidden="true" />}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="bb-curves">
        <PressDemo />
        <RevealDemo />
      </div>

      <ReleaseSpecimen />
    </Section>
  );
}

// ------------------------------------------------------------ 6 components

const KINDS = [
  { cls: 'primary', name: 'Primary', label: 'Sign and seal' },
  { cls: '', name: 'Secondary', label: 'Copy the address' },
  { cls: 'ghost', name: 'Ghost', label: 'Not now' },
  { cls: 'danger', name: 'Danger', label: 'Stop the plan' },
];
const STATES = [
  { cls: '', name: 'Rest' },
  { cls: 'is-hover', name: 'Hover' },
  { cls: 'is-active', name: 'Pressed' },
  { cls: 'is-focus', name: 'Focus' },
  { cls: 'is-disabled', name: 'Disabled' },
];
const BADGES: Array<{ state: InstallmentState; note: string }> = [
  { state: 'sealed', note: 'Ledger outline' },
  { state: 'due', note: 'Release outline: next' },
  { state: 'broadcast', note: 'Release fill: now' },
  { state: 'mined', note: 'Settled green' },
  { state: 'cancelled', note: 'Graphite' },
  { state: 'missed', note: 'Refused red' },
];

function ComponentsSection() {
  return (
    <Section id="components" rule="Square-cut controls, 44 px tall. One primary action per view.">
      <div className="bb-buttons">
        <button type="button" className="btn primary">
          Sign and seal <ArrowRightIcon className="arrow" />
        </button>
        <button type="button" className="btn">
          Copy the address
        </button>
        <button type="button" className="btn ghost">
          Not now
        </button>
        <button type="button" className="btn danger">
          Stop the plan
        </button>
      </div>
      <div className="bb-buttons">
        <button type="button" className="btn sm">
          Small, 32 px
        </button>
        <button type="button" className="btn">
          Default, 44 px
        </button>
        <button type="button" className="btn lg">
          Large, 52 px
        </button>
        <button type="button" className="btn primary" disabled>
          Waiting for your payment
        </button>
      </div>

      <div className="bb-scroll" role="region" aria-label="Button states" tabIndex={0}>
        <table className="bb-states">
          <caption className="bb-caption">
            Every state, held still<span className="bb-scroll-hint">. Scroll sideways for all five.</span>
          </caption>
          <thead>
            <tr>
              <td />
              {STATES.map((s) => (
                <th key={s.name} scope="col">
                  {s.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {KINDS.map((k) => (
              <tr key={k.name}>
                <th scope="row">{k.name}</th>
                {STATES.map((s) => (
                  <td key={s.name}>
                    <span className={['btn', k.cls, s.cls].filter(Boolean).join(' ')}>{k.label}</span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="bb-badges">
        {BADGES.map((b) => (
          <li key={b.state}>
            <StateBadge state={b.state} />
            <span className="bb-badge-note">{b.note}</span>
          </li>
        ))}
      </ul>

      <div className="bb-focus">
        <Plate className="bb-tile plate-vault" caption={<>Release on Vault, <Ratio fg={HEX.Release} bg={HEX.Vault} /></>}>
          <span className="btn is-focus">Copy the address</span>
        </Plate>
        <Plate className="bb-tile plate-paper" caption={<>#8A5B00 on Paper, <Ratio fg="#8A5B00" bg={HEX.Paper} /></>}>
          <span className="btn is-focus">Copy the address</span>
        </Plate>
        <Plate className="bb-tile plate-vault" caption="Around a Release fill, the ring stands 3 px clear.">
          <span className="btn primary is-focus">Sign and seal</span>
        </Plate>
      </div>
      <p className="bb-note">The focus ring: 2 px, 3 px clear on buttons and links, 2 px on inputs. Press Tab on this page to see it live.</p>
    </Section>
  );
}

// ------------------------------------------------------------ 7 texture

function TextureSection() {
  return (
    <Section id="texture" rule="Print, not pixels: grain, ruled lines, perforations and engraving.">
      <div className="bb-textures">
        <Plate className="bb-texture" caption="Grain: a same-origin SVG tile at 4.5% on dark and 3.5% on light. Shown here at ten times that.">
          <div className="bb-grain" />
        </Plate>
        <Plate className="bb-texture" caption="The rung rule: 1 px on, 2 px off. Dividers and progress fills.">
          <div className="bb-rules-demo">
            <span className="bb-rung-rule" />
            <span className="bb-rung-rule muted" />
            <span className="bb-progress" aria-hidden="true">
              <span />
            </span>
          </div>
        </Plate>
        <Plate className="bb-texture" caption="Perforation: holes 2.5 px in radius (5 px across) at a 10 px pitch, on the cancel key and certificate stubs.">
          <div className="bb-stub-ground">
            <div className="bb-stub">
              <span className="bb-stub-main">
                <span className="bb-stub-kicker">Cancellation certificate</span>
                <span className="bb-stub-line">Cancelled at block {fmt(RUN2.cancelHeight)}.</span>
              </span>
              <span className="bb-stub-tear" aria-hidden="true" />
              <span className="bb-stub-end">Run 2</span>
            </div>
          </div>
        </Plate>
        <Plate
          className="bb-texture"
          caption={
            <>
              Guilloché, drawn from a transaction: run 1’s first payment <span className="mono">{shortTxid(RUN1.txid1)}</span> and run 2’s cancel{' '}
              <span className="mono">{shortTxid(RUN2.cancelTxid)}</span>. Different transactions, different engravings.
            </>
          }
        >
          <div className="bb-rosettes">
            <Guilloche seed={RUN1.txid1} />
            <Guilloche seed={RUN2.cancelTxid} />
          </div>
        </Plate>
      </div>
    </Section>
  );
}

// ------------------------------------------------------------ 8 downloads

const FILES: Array<{ file: string; name: string; what: string; tone: 'vault' | 'paper' }> = [
  { file: 'mark.svg', name: 'Mark', what: 'Ledger and Release, for dark grounds', tone: 'vault' },
  { file: 'mark-light.svg', name: 'Mark, light', what: 'Ink and #B07800, for light grounds', tone: 'paper' },
  { file: 'lockup.svg', name: 'Lockup', what: 'Mark and wordmark, for dark grounds', tone: 'vault' },
  { file: 'lockup-light.svg', name: 'Lockup, light', what: 'Mark and wordmark, for light grounds', tone: 'paper' },
  { file: 'wordmark.svg', name: 'Wordmark', what: 'Outlined, in Ledger', tone: 'vault' },
  { file: 'wordmark-light.svg', name: 'Wordmark, light', what: 'Outlined, in Ink', tone: 'paper' },
  { file: 'app-icon.svg', name: 'App icon', what: 'The mark on a 512 Vault tile', tone: 'paper' },
];

function DownloadsSection() {
  return (
    <Section id="downloads" rule="Every file is drawn from the same sources as this page, and none of them contains live text.">
      <ul className="bb-files">
        {FILES.map((f) => (
          <li key={f.file} className="bb-file">
            <span className={`bb-file-thumb plate-${f.tone}`}>
              <img src={`/brand-assets/${f.file}`} alt="" loading="lazy" />
            </span>
            <span className="bb-file-meta">
              <span className="bb-file-name">{f.name}</span>
              <span className="bb-file-what">{f.what}</span>
            </span>
            <a className="btn sm" href={`/brand-assets/${f.file}`} download>
              <DownloadGlyph />
              {f.file}
            </a>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function DownloadGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="square" aria-hidden="true" focusable="false">
      <path d="M12 4v11M7 10.5l5 5 5-5M5 19.5h14" />
    </svg>
  );
}

// ------------------------------------------------------------ 9 social card

const OG = { width: 1200, height: 630 };
/**
 * Ladder 1's centre. The spec put it at 768, but Bodoni sets "Subscribe once." at 92 px
 * to x 701, a hair from the pulled rung; 40 px right keeps the ladders inside the spec's
 * 700-1128 band and gives the headline room.
 */
const OG_LADDER_X = 808;

/** The 1200 × 630 card (spec §5), drawn at true size; export-assets.mjs screenshots it. */
function OgCard() {
  const g = ladderGeometry();
  return (
    <div
      id="og-card"
      className="og-card"
      role="img"
      aria-label="Social card: the Cadence lockup, “Subscribe once. Close the tab.”, and testnet run 1’s three ladders with one rung pulled out in amber."
    >
      <svg viewBox={`0 0 ${OG.width} ${OG.height}`} width={OG.width} height={OG.height} aria-hidden="true" focusable="false">
        <Lockup size={44} x={72} y={106 - lockupBaseline(44)} />
        <text className="og-display" x="72" y="330">
          Subscribe once.
        </text>
        <text className="og-display og-italic" x="72" y="430">
          Close the tab.
        </text>
        <text className="og-kicker" x="72" y="566">
          SHIELDED STANDING ORDERS · ZCASH IRONWOOD
        </text>
        <LadderArt snap x={OG_LADDER_X - g.centres[0]!} y={560 - g.base} />
        <text className="og-caption" x="1128" y="602" textAnchor="end">
          Testnet run 1 · {RUN1.rungs.join(' / ')} rungs
        </text>
      </svg>
    </div>
  );
}

function SocialCardSection() {
  const frame = useRef<HTMLDivElement>(null);
  // Scale the true-size card to the column; the frame's aspect ratio holds the space.
  useLayoutEffect(() => {
    const el = frame.current;
    if (!el) return;
    const fit = () => el.style.setProperty('--og-scale', String(el.clientWidth / OG.width));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <Section id="social-card" rule={`What a shared link shows: ${OG.width} × ${OG.height}, exported from this page at true size.`}>
      <Plate
        className="bb-plate-og"
        caption={
          <>
            Shown scaled to fit. The ladders are run 1 at {RUN1.rungs.join(', ')} rungs, 2.6 px a block; the amber rung is installment 1’s, block{' '}
            {fmt(RUN1.mined[0])}, drawn {RUN1_RELEASED_INDEX} rungs above the base (the signing tip isn’t on file, so the funding height stands in).
          </>
        }
      >
        <div className="og-frame" ref={frame}>
          <OgCard />
        </div>
      </Plate>
    </Section>
  );
}

// ------------------------------------------------------------ page

export function Brand() {
  useDocumentTitle('Brand');
  const lenis = useSmoothScroll();
  // A shared /brand#section link: the browser looked for the section before this lazy page
  // rendered, so go there once it has, and once the text faces have set (they reflow it).
  useEffect(() => {
    const id = decodeURIComponent(location.hash.slice(1));
    if (!id) return;
    let live = true;
    let raf = 0;
    const go = () => {
      if (live) raf = requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ block: 'start' }));
    };
    void (document.fonts?.ready ?? Promise.resolve()).then(go, go);
    return () => {
      live = false;
      cancelAnimationFrame(raf);
    };
  }, []);
  return (
    <div className="brand-book page">
      <Masthead />
      <Contents lenis={lenis} />
      <MarkSection />
      <WordmarkSection />
      <ColourSection />
      <TypeSection />
      <MotionSection />
      <ComponentsSection />
      <TextureSection />
      <DownloadsSection />
      <SocialCardSection />
    </div>
  );
}
