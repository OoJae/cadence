import type { InstallmentState, SubscriptionStatus } from '../api/types';

export type Tone = 'sealed' | 'amber' | 'blue' | 'green' | 'muted' | 'red';

export interface StateInfo {
  label: string;
  tone: Tone;
  /** One honest sentence, from the runner's point of view (docs/api.md). */
  description: string;
}

export const INSTALLMENT_STATES: readonly InstallmentState[] = ['sealed', 'due', 'broadcast', 'mined', 'cancelled', 'missed', 'invalid'];

export const INSTALLMENT_STATE_INFO: Record<InstallmentState, StateInfo> = {
  sealed: {
    label: 'Sealed',
    tone: 'sealed',
    description: 'Still time-locked to its drand round. Not even the runner can read it.',
  },
  due: {
    label: 'Due',
    tone: 'amber',
    description: 'The drand round has passed and the package is open. The runner is waiting for anchor depth.',
  },
  broadcast: {
    label: 'Broadcast',
    tone: 'blue',
    description: 'Sent to the network, not yet mined.',
  },
  mined: {
    label: 'Mined',
    tone: 'green',
    description: 'Confirmed on chain.',
  },
  cancelled: {
    label: 'Cancelled',
    tone: 'muted',
    description: 'The pocket note it spends is gone (the payer spent it, or the merchant stopped), so it can never be valid.',
  },
  missed: {
    label: 'Missed',
    tone: 'red',
    description: 'No pre-signed rung covers the current height, so nothing was broadcast. The merchant is notified; the payer can cancel or sweep, and subscribe again.',
  },
  invalid: {
    label: 'Invalid',
    tone: 'red',
    description: "The package did not match the offer (wrong amount, recipient or expiry), so nothing was broadcast. The payer can cancel or sweep, and subscribe again.",
  },
};

export const SUBSCRIPTION_STATUS_INFO: Record<SubscriptionStatus, StateInfo> = {
  active: { label: 'Active', tone: 'blue', description: 'Installments are sealed with the runner and release on schedule.' },
  completed: { label: 'Completed', tone: 'green', description: 'Every installment is mined.' },
  cancelled: { label: 'Cancelled', tone: 'muted', description: 'Stopped before the last installment. Nothing further can be released.' },
  stopped: { label: 'Stopped', tone: 'muted', description: 'The merchant stopped it. The runner shredded the remaining packages; what is left in the pocket is the payer’s to sweep.' },
  stalled: { label: 'Stalled', tone: 'red', description: 'An installment was missed or invalid, so nothing further pays. The payer can cancel or sweep, and subscribe again.' },
};

export function installmentStateInfo(state: string): StateInfo {
  return (
    INSTALLMENT_STATE_INFO[state as InstallmentState] ?? {
      label: `Unknown (${state})`,
      tone: 'muted',
      description: 'The runner reported a state this app does not know.',
    }
  );
}

export function subscriptionStatusInfo(status: string): StateInfo {
  return (
    SUBSCRIPTION_STATUS_INFO[status as SubscriptionStatus] ?? {
      label: `Unknown (${status})`,
      tone: 'muted',
      description: 'The runner reported a status this app does not know.',
    }
  );
}

/** Terminal states never change again; the dashboard can stop counting down. */
export function isTerminal(state: InstallmentState): boolean {
  return state === 'mined' || state === 'cancelled' || state === 'missed' || state === 'invalid';
}
