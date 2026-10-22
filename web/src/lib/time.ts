export const nowSecs = (): number => Date.now() / 1000;

const pad = (n: number) => String(n).padStart(2, '0');

/** "2d 03:14:07", "03:14:07", "00:41". Always non-negative. */
export function formatCountdown(totalSecs: number): string {
  const s = Math.max(0, Math.floor(totalSecs));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${pad(h)}:${pad(m)}:${pad(sec)}`;
  if (h > 0) return `${pad(h)}:${pad(m)}:${pad(sec)}`;
  return `${pad(m)}:${pad(sec)}`;
}

/** "in 41 s", "in 3 min", "2 h ago", "29 days ago". */
export function formatRelative(deltaSecs: number): string {
  const future = deltaSecs >= 0;
  const a = Math.abs(deltaSecs);
  let text: string;
  if (a < 1) return 'now';
  if (a < 60) text = `${Math.floor(a)} s`;
  else if (a < 3600) text = `${Math.floor(a / 60)} min`;
  else if (a < 86400 * 2) text = `${Math.floor(a / 3600)} h`;
  else text = `${Math.floor(a / 86400)} days`;
  return future ? `in ${text}` : `${text} ago`;
}

export function formatDateTime(unixSecs: number): string {
  return new Date(unixSecs * 1000).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function formatDate(unixSecs: number): string {
  return new Date(unixSecs * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function formatTime(unixSecs: number): string {
  return new Date(unixSecs * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** "every 30 days", "every week", "every 20 s". */
export function formatPeriod(secs: number): string {
  const named: Record<number, string> = {
    3600: 'every hour',
    86400: 'every day',
    604800: 'every week',
    2592000: 'every 30 days',
    31536000: 'every year',
  };
  if (named[secs]) return named[secs]!;
  if (secs < 120) return `every ${secs} s`;
  if (secs < 7200) return `every ${Math.round(secs / 60)} min`;
  if (secs < 172800) return `every ${Math.round(secs / 3600)} h`;
  return `every ${Math.round(secs / 86400)} days`;
}
