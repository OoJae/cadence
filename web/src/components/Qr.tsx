import { useMemo } from 'react';
import { encode } from 'uqr';

/**
 * QR code rendered as an inline SVG path from a bundled encoder (uqr): no canvas, no
 * image URL, no network. Dark modules on a light tile in both themes, so any phone
 * camera reads it.
 */
export function Qr({ value, label, ribbon, size = 280 }: { value: string; label: string; ribbon?: string; size?: number }) {
  const { path, n } = useMemo(() => {
    // Two modules of border inside the tile's own padding give a full quiet zone.
    const qr = encode(value, { ecc: 'M', border: 2 });
    let d = '';
    qr.data.forEach((row, y) => {
      let x = 0;
      while (x < row.length) {
        if (!row[x]) {
          x++;
          continue;
        }
        let w = 1;
        while (x + w < row.length && row[x + w]) w++;
        d += `M${x} ${y}h${w}v1h-${w}z`;
        x += w;
      }
    });
    return { path: d, n: qr.size };
  }, [value]);

  return (
    <div className="qr-frame" style={{ width: size }}>
      <svg viewBox={`0 0 ${n} ${n}`} role="img" aria-label={label} shapeRendering="crispEdges">
        <title>{label}</title>
        <rect width={n} height={n} fill="var(--qr-bg)" />
        <path d={path} fill="var(--qr-fg)" />
      </svg>
      {ribbon && <span className="qr-ribbon">{ribbon}</span>}
    </div>
  );
}
