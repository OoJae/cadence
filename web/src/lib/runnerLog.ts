/**
 * Turns observed installment state changes into log lines in the style of
 * crates/cadence-runner's log, so the sandbox reads like a runner's terminal. They are
 * written here, not copied from the runner: each line says only what the API fields
 * show, on any network. Works against any runner.
 */
import type { Installment, InstallmentState, Subscription } from '../api/types';
import { ANCHOR_DEPTH } from './shape';

export interface LogLine {
  at: number;
  text: string;
  tone?: 'ok' | 'err' | 'warn';
}

const PROGRESSION: InstallmentState[] = ['sealed', 'due', 'broadcast', 'mined'];

/** The input installment k spends was mined here: the funding note for k = 1, else C(k−1). */
export function inputMinedHeight(sub: Subscription, k: number): number | undefined {
  if (k === 1) return sub.funding.mined_height || undefined;
  return sub.installments.find((i) => i.k === k - 1)?.mined_height;
}

function lineFor(state: InstallmentState, inst: Installment, sub: Subscription): Omit<LogLine, 'at'> | null {
  const k = inst.k;
  const input = inputMinedHeight(sub, k);
  const target = inst.target_height;
  switch (state) {
    case 'sealed':
      return { text: `installment ${k}: sealed; tlock round ${inst.release_round}, age to this runner` };
    case 'due':
      return input
        ? { text: `installment ${k}: input mined at ${input}, waiting for anchor depth`, tone: 'warn' }
        : { text: `installment ${k}: input not yet on chain, waiting`, tone: 'warn' };
    case 'broadcast':
      if (!inst.txid || !target) return null;
      return {
        text: `installment ${k}: broadcast ${inst.txid} for target ${target} (input mined at ${input ?? '?'}, anchor ${target - ANCHOR_DEPTH})`,
      };
    case 'mined': {
      if (!inst.mined_height) return null;
      return {
        text: `installment ${k}: mined at ${inst.mined_height}${target ? ` (target ${target})` : ''}; decode it for its shape`,
        tone: 'ok',
      };
    }
    case 'cancelled':
      return { text: `installment ${k}: its input was spent elsewhere; mandate cancelled`, tone: 'err' };
    case 'missed':
      return { text: `installment ${k}: no rung for target ${target ?? 'tip + 1'}: missed`, tone: 'err' };
    case 'invalid':
      return { text: `installment ${k}: refusing the package: it does not match the offer`, tone: 'err' };
  }
}

/** Lines for moving from `prev` (undefined = first sighting) to the installment's current state. */
export function transitionLines(prev: InstallmentState | undefined, inst: Installment, sub: Subscription): Array<Omit<LogLine, 'at'>> {
  if (prev === inst.state) return [];
  const from = prev ? PROGRESSION.indexOf(prev) : -1;
  const to = PROGRESSION.indexOf(inst.state);
  const states: InstallmentState[] = from >= 0 && to > from ? PROGRESSION.slice(from + 1, to + 1) : [inst.state];
  return states.map((s) => lineFor(s, inst, sub)).filter((l): l is Omit<LogLine, 'at'> => l !== null);
}
