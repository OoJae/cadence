import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 16, children, ...rest }: P) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="square"
      strokeLinejoin="miter"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const LockIcon = (p: P) => (
  <Svg {...p}>
    <rect x="4.5" y="10.5" width="15" height="10" rx="2.5" />
    <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
  </Svg>
);
export const UnlockIcon = (p: P) => (
  <Svg {...p}>
    <rect x="4.5" y="10.5" width="15" height="10" rx="2.5" />
    <path d="M8 10.5V7.5a4 4 0 0 1 7.7-1.5" />
  </Svg>
);
export const CheckIcon = (p: P) => (
  <Svg {...p}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </Svg>
);
export const XIcon = (p: P) => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Svg>
);
export const CopyIcon = (p: P) => (
  <Svg {...p}>
    <rect x="8.5" y="8.5" width="11" height="11" rx="2.5" />
    <path d="M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2" />
  </Svg>
);
export const ArrowRightIcon = (p: P) => (
  <Svg {...p}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </Svg>
);
export const SunIcon = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4" />
  </Svg>
);
export const MoonIcon = (p: P) => (
  <Svg {...p}>
    <path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5Z" />
  </Svg>
);
export const ClockIcon = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </Svg>
);
export const EyeIcon = (p: P) => (
  <Svg {...p}>
    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
    <circle cx="12" cy="12" r="2.75" />
  </Svg>
);
export const EyeOffIcon = (p: P) => (
  <Svg {...p}>
    <path d="M10.6 5.6A9.6 9.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a16 16 0 0 1-2.7 3.4M6.3 6.9C3.9 8.5 2.5 12 2.5 12S6 18.5 12 18.5a9 9 0 0 0 4.4-1.1" />
    <path d="m3 3 18 18M9.9 10a2.75 2.75 0 0 0 3.9 3.9" />
  </Svg>
);
export const ShieldIcon = (p: P) => (
  <Svg {...p}>
    <path d="M12 3 4.5 6v5.5c0 4.6 3.1 8.3 7.5 9.5 4.4-1.2 7.5-4.9 7.5-9.5V6L12 3Z" />
  </Svg>
);
export const ShieldCheckIcon = (p: P) => (
  <Svg {...p}>
    <path d="M12 3 4.5 6v5.5c0 4.6 3.1 8.3 7.5 9.5 4.4-1.2 7.5-4.9 7.5-9.5V6L12 3Z" />
    <path d="m8.8 12.2 2.3 2.3 4.3-4.6" />
  </Svg>
);
export const RadioIcon = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="2" />
    <path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 16.2a6 6 0 0 0 0-8.4M5 5a10 10 0 0 0 0 14M19 19a10 10 0 0 0 0-14" />
  </Svg>
);
export const CubeIcon = (p: P) => (
  <Svg {...p}>
    <path d="M12 2.8 20 7.3v9.4l-8 4.5-8-4.5V7.3l8-4.5Z" />
    <path d="M4 7.3l8 4.5 8-4.5M12 11.8v9.4" />
  </Svg>
);
export const AlertIcon = (p: P) => (
  <Svg {...p}>
    <path d="M12 4 2.8 19.5h18.4L12 4Z" />
    <path d="M12 10v4M12 17h.01" />
  </Svg>
);
export const InfoIcon = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 11v5M12 8h.01" />
  </Svg>
);
export const BanIcon = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="m6 6 12 12" />
  </Svg>
);
export const KeyIcon = (p: P) => (
  <Svg {...p}>
    <circle cx="8" cy="15" r="3.5" />
    <path d="m10.5 12.5 8-8M15.5 7.5l2 2M17.5 5.5l2 2" />
  </Svg>
);
export const QrIcon = (p: P) => (
  <Svg {...p}>
    <rect x="4" y="4" width="6" height="6" rx="1" />
    <rect x="14" y="4" width="6" height="6" rx="1" />
    <rect x="4" y="14" width="6" height="6" rx="1" />
    <path d="M14 14h2v2h-2zM18 18h2v2h-2zM18 14h2M14 18v2" />
  </Svg>
);
export const UserIcon = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="8.5" r="3.5" />
    <path d="M5 20a7 7 0 0 1 14 0" />
  </Svg>
);
export const ServerIcon = (p: P) => (
  <Svg {...p}>
    <rect x="4" y="4" width="16" height="7" rx="2" />
    <rect x="4" y="13" width="16" height="7" rx="2" />
    <path d="M8 7.5h.01M8 16.5h.01" />
  </Svg>
);
export const PenIcon = (p: P) => (
  <Svg {...p}>
    <path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4Z" />
    <path d="m13.5 6.5 4 4" />
  </Svg>
);
export const TabIcon = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="5" width="18" height="14" rx="2.5" />
    <path d="M3 9h18M9.5 14.5l5-3M9.5 11.5l5 3" />
  </Svg>
);
export const SearchIcon = (p: P) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m16 16 4.5 4.5" />
  </Svg>
);
export const LinkIcon = (p: P) => (
  <Svg {...p}>
    <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
    <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
  </Svg>
);
export const BoltIcon = (p: P) => (
  <Svg {...p}>
    <path d="M13 2.5 5 13.5h6l-1 8 8-11h-6l1-8Z" />
  </Svg>
);

/*
 * Installment states as mini ladders: two rails and their rungs, one installment's
 * pre-signed copies. What happens to the rungs is the state.
 */

/** Sealed: the ladder locked away until its drand round. */
export const SealedGlyph = (p: P) => (
  <Svg {...p}>
    <path d="M8.75 10.25V7a3.25 3.25 0 0 1 6.5 0v3.25" />
    <rect x="5.75" y="10.25" width="12.5" height="10.5" />
    <path d="M10 12.75v5.5M14 12.75v5.5M10 15.5h4" />
  </Svg>
);
/** Due: its round has passed and the seal is lifted; nothing has gone out yet. */
export const DueGlyph = (p: P) => (
  <Svg {...p}>
    <path d="M5.75 7.25V3.25h12.5v4" />
    <path d="M9.5 9.5v11.25M14.5 9.5v11.25M9.5 12.75h5M9.5 16.25h5M9.5 19.75h5" />
  </Svg>
);
/** Broadcast: exactly one rung pulled out, as in the mark. */
export const BroadcastGlyph = (p: P) => (
  <Svg {...p}>
    <path d="M11.5 3.75v16.5M17.5 3.75v16.5M11.5 7.5h6M11.5 16.5h6" />
    <path d="M3 12h5.5" />
  </Svg>
);
/** Mined: the pulled rung sits in a block. */
export const MinedGlyph = (p: P) => (
  <Svg {...p}>
    <path d="M12.5 3.75v16.5M18.5 3.75v16.5M12.5 7.5h6M12.5 12h6" />
    <rect x="3.25" y="14" width="6.25" height="6.25" />
    <path d="M5 17.125h2.75" />
  </Svg>
);
/** Cancelled: the note every rung spends is gone, so the whole ladder is struck. */
export const CancelledGlyph = (p: P) => (
  <Svg {...p}>
    <path d="M9 3.75v16.5M15 3.75v16.5M9 8h6M9 12h6M9 16h6" />
    <path d="M4 20 20 4" />
  </Svg>
);
/** Missed or invalid: no rung could go out. */
export const RefusedGlyph = (p: P) => (
  <Svg {...p}>
    <path d="M12.5 3.75v16.5M18.5 3.75v16.5M12.5 7.5h6M12.5 16.5h6" />
    <path d="m3.5 9.5 5 5M8.5 9.5l-5 5" />
  </Svg>
);

/**
 * The Cadence mark, "the pulled rung": three bars, and out of the first one the single
 * rung that goes out next, in the only amber. On a 48 grid; minimum size 16 px.
 */
export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true" focusable="false" className="logo">
      <path fill="var(--text)" d="M14.5 8h7v21h-7zM14.5 32h7v8h-7zM25.5 8h7v32h-7zM36.5 8h7v32h-7z" />
      <rect className="logo-rung" x="4.5" y="29" width="7" height="3" fill="var(--accent-graphic)" />
    </svg>
  );
}
