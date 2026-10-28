import type { RunnerFeature, RunnerStatus } from '../api/types';

/**
 * Whether the runner lists `feature` in its status. The app sends or shows a v2 thing only
 * then: an older runner sends no `features` at all, which means none, and the app talks to
 * it exactly as before.
 */
export function hasFeature(status: Pick<RunnerStatus, 'features'> | null | undefined, feature: RunnerFeature): boolean {
  return Array.isArray(status?.features) && status.features.includes(feature);
}
