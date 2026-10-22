/**
 * Shallow, offline sanity checks on address-like strings. These do not verify Bech32m
 * checksums or F4Jumble (the signer does that); they catch typos, wrong networks and
 * pasted garbage before anything is shown as a payment target.
 */
import type { NetworkId } from './zat';

export const BECH32_CHARS = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const DATA = `[${BECH32_CHARS}]`;

const UA = { main: new RegExp(`^u1${DATA}{60,1000}$`), test: new RegExp(`^utest1${DATA}{60,1000}$`) };
const UFVK = { main: new RegExp(`^uview1${DATA}{60,2000}$`), test: new RegExp(`^uviewtest1${DATA}{60,2000}$`) };
const AGE_RECIPIENT = new RegExp(`^age1${DATA}{58}$`);

export function isUnifiedAddress(s: string, network: NetworkId): boolean {
  return UA[network].test(s);
}

export function isUfvk(s: string, network: NetworkId): boolean {
  return UFVK[network].test(s);
}

export function isAgeRecipient(s: string): boolean {
  return AGE_RECIPIENT.test(s);
}

export function uaPrefix(network: NetworkId): string {
  return network === 'main' ? 'u1' : 'utest1';
}

/** Middle-truncates long identifiers for display: "utest1qx7…9f3k2". */
export function shorten(s: string, head = 10, tail = 6): string {
  if (s.includes('…')) return s;
  return s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`;
}
