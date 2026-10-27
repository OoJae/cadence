/**
 * Which runner a page talks to: the one an offer (`runner_endpoint`) or a cancel key
 * (`runner`) names, and only if this build knows it. src/runtime.ts holds the clients;
 * this is the rule, without them, so it can be tested.
 */

export interface KnownRunner {
  /** Absolute base URL, as offers and cancel keys name it. */
  url: string;
  /** What the CSP connect-src allows, and what a named runner is matched by. */
  origin: string;
}

function originOf(url: string): string | null {
  try {
    const origin = new URL(url.trim()).origin;
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}

/** The known runner on the origin a URL names, or null. Paths and trailing slashes do not matter. */
export function matchRunner<T extends KnownRunner>(known: readonly T[], named: string): T | null {
  const origin = originOf(named);
  return (origin && known.find((r) => r.origin === origin)) || null;
}

/**
 * Asks each runner in `order` until one answers with anything but "not found", and says
 * which one answered. Any other failure stops there. If no runner knows it, the first
 * runner's "not found" stands.
 */
export async function askInTurn<R, T>(order: readonly R[], ask: (runner: R) => Promise<T>, notFound: (e: unknown) => boolean): Promise<{ value: T; runner: R }> {
  let missing: unknown = new Error('there is no runner to ask');
  for (const [i, runner] of order.entries()) {
    try {
      return { value: await ask(runner), runner };
    } catch (e) {
      if (!notFound(e)) throw e;
      if (i === 0) missing = e;
    }
  }
  throw missing;
}

/** "A", "A and B", "A, B and C" (or "A or B", …). */
export function listRunners(urls: readonly string[], conjunction: 'and' | 'or' = 'and'): string {
  if (urls.length <= 1) return urls[0] ?? 'no runner';
  return `${urls.slice(0, -1).join(', ')} ${conjunction} ${urls[urls.length - 1]}`;
}

/**
 * Why a page will not use the runner an offer or a cancel key names, and where to go
 * instead. `appHost` is VITE_API=runners: an app of its own that knows several runners.
 * With one runner the wording is the one /subscribe and kitTargetProblem() always used.
 */
export function unknownRunnerMessage(named: string, what: 'offer' | 'cancel key', known: readonly KnownRunner[], appHost: boolean): string {
  const there = (originOf(named) ?? named.trim()).replace(/\/+$/, '');
  if (what === 'offer') {
    return appHost
      ? `This offer names the runner ${named}, but this app talks only to ${listRunners(known.map((r) => r.origin))}. Open the link in that runner's own app instead: ${there}/subscribe with the same #offer=… part.`
      : `This offer names the runner ${named}, but this page is built to talk only to ${known[0]?.origin ?? 'no runner'}. Open the link on that runner's own page.`;
  }
  return appHost
    ? `This cancel key belongs to the runner at ${named}, but this app talks only to ${listRunners(known.map((r) => r.url))}. Open it in that runner's own app (${there}/manage) instead, or use the CLI.`
    : `This cancel key belongs to the runner at ${named}, but this page talks only to ${known[0]?.url ?? 'no runner'}. Open ${named.replace(/\/+$/, '')}/manage instead, or use the CLI.`;
}
